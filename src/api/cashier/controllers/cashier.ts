/**
 * cashier controller
 */

import type { Context } from "koa";

interface SaleItem {
  id: number;
  name: string;
  sku: string;
  stockQty: number;
  minThreshold: number;
  unit: string;
  price: number | null;
  isForSale: boolean;
}

interface CashierLine {
  item: number;
  qtyPulled: number;
}

interface TransactionLine {
  id: number;
  qtyPulled: number;
  item: SaleItem | null;
}

interface TransactionEntity {
  id: number;
  documentId: string;
  orderStatus: "Pending" | "Completed" | "Voided";
  notes?: string | null;
  items?: TransactionLine[];
  custodian?: { id: number; username: string } | null;
}

interface MovedStock {
  name: string;
  qty: number;
  stockQty: number;
  minThreshold: number;
}

const ITEMS_API = "api::item.item";
const TRANSACTIONS_API = "api::transaction.transaction";
const AUDIT_LOG_API = "api::audit-log.audit-log";

function badRequest(message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

function summarize(items: TransactionLine[]): string {
  return items
    .map((line) => `${line.qtyPulled} x ${line.item?.name ?? `#${line.id}`}`)
    .join(", ");
}

function parseSaleLines(payload: unknown): {
  lines: CashierLine[];
  notes: string;
} {
  const body = (payload ?? {}) as { items?: unknown; notes?: unknown };
  const lines: CashierLine[] = Array.isArray(body.items)
    ? (body.items as CashierLine[])
    : [];

  if (lines.length === 0) {
    throw badRequest("At least one item is required.");
  }

  const notes = typeof body.notes === "string" ? body.notes.trim() : "";

  for (const line of lines) {
    if (
      !Number.isInteger(line.item) ||
      !Number.isInteger(line.qtyPulled) ||
      line.qtyPulled < 1
    ) {
      throw badRequest(
        "Each line item requires a valid item id and a quantity of at least 1.",
      );
    }
  }

  const ids = [...new Set(lines.map((line) => line.item))];
  if (ids.length !== lines.length) {
    throw badRequest("Duplicate items are not allowed.");
  }

  return { lines, notes };
}

async function loadItemsByIds(ids: number[]): Promise<Map<number, SaleItem>> {
  const existing = await strapi.documents(ITEMS_API).findMany({
    filters: { id: { $in: ids } },
  });

  return new Map(
    existing.map((item) => [
      item.id as number,
      item as unknown as SaleItem,
    ]),
  );
}

function assertSaleEligibility(
  lines: CashierLine[],
  byId: Map<number, SaleItem>,
): void {
  for (const line of lines) {
    const item = byId.get(line.item);
    if (!item) {
      throw badRequest(`Item #${line.item} does not exist.`);
    }
    if (!item.isForSale) {
      throw badRequest(`"${item.name}" is not available for sale.`);
    }
  }
}

function assertSufficientStock(
  lines: CashierLine[],
  byId: Map<number, SaleItem>,
): void {
  for (const line of lines) {
    const item = byId.get(line.item)!;
    if (line.qtyPulled > item.stockQty) {
      throw badRequest(`Only ${item.stockQty} of "${item.name}" are in stock.`);
    }
  }
}

async function decrementStock(items: TransactionLine[]): Promise<MovedStock[]> {
  const moved: MovedStock[] = [];

  await strapi.db.transaction(async ({ trx }) => {
    for (const line of items) {
      const row = await trx("items")
        .where({ id: line.item!.id })
        .forUpdate()
        .first();

      if (!row) {
        throw badRequest(
          `Item "${line.item!.name}" no longer exists in inventory.`,
        );
      }

      if (row.stock_qty < line.qtyPulled) {
        throw badRequest(
          `Not enough stock for "${line.item!.name}" (available: ${row.stock_qty}).`,
        );
      }

      await trx("items")
        .where({ id: line.item!.id })
        .update({ stock_qty: row.stock_qty - line.qtyPulled });

      moved.push({
        name: row.name,
        qty: line.qtyPulled,
        stockQty: row.stock_qty - line.qtyPulled,
        minThreshold: row.min_threshold,
      });
    }
  });

  return moved;
}

async function writeStockAuditLogs(
  user: { id: number; username: string },
  moved: MovedStock[],
  transactionId: number,
): Promise<void> {
  for (const stock of moved) {
    await strapi.documents(AUDIT_LOG_API).create({
      data: {
        user: user.id,
        action: "Stock Out",
        category: "Inventory",
        target: stock.name,
        detail: `${stock.qty} unit(s) issued via transaction #${transactionId}.`,
      },
    });

    if (stock.stockQty <= stock.minThreshold) {
      await strapi.documents(AUDIT_LOG_API).create({
        data: {
          user: user.id,
          action: "Threshold Reached",
          category: "Inventory",
          target: stock.name,
          detail: `Stock is now ${stock.stockQty}, at or below the threshold of ${stock.minThreshold}.`,
        },
      });
    }
  }
}

async function loadTransaction(
  documentId: string,
): Promise<TransactionEntity | null> {
  const result = await strapi.documents(TRANSACTIONS_API).findMany({
    filters: { documentId } as never,
    populate: {
      custodian: true,
      items: { populate: { item: true } },
    },
  });
  const found = result as unknown as TransactionEntity[];

  return found[0] ?? null;
}

export default {
  /**
   * List items that cashiers may sell. Only items with isForSale set to true
   * are returned.
   */
  async find(ctx: Context) {
    const user = ctx.state.user as { id: number; username: string } | undefined;
    if (!user?.id) {
      throw badRequest("Not authenticated.");
    }

    const saleItems = await strapi.documents(ITEMS_API).findMany({
      filters: { isForSale: true },
    });

    return {
      data: (saleItems as unknown as SaleItem[]).map((item) => ({
        id: item.id,
        name: item.name,
        sku: item.sku,
        stockQty: item.stockQty,
        price: item.price,
        unit: item.unit,
        minThreshold: item.minThreshold,
      })),
    };
  },

  /**
   * Issue stock for a sale in a single step: atomically decrement inventory and
   * create a Completed transaction. Only items marked isForSale are accepted.
   * Body: { items: [{ item: <id>, qtyPulled: <int> }], notes?: string }
   */
  async issue(ctx: Context) {
    const user = ctx.state.user as { id: number; username: string } | undefined;
    if (!user?.id) {
      throw badRequest("Not authenticated.");
    }

    const { lines, notes } = parseSaleLines(ctx.request.body);
    const byId = await loadItemsByIds(lines.map((line) => line.item));
    assertSaleEligibility(lines, byId);
    assertSufficientStock(lines, byId);

    const stockLines: TransactionLine[] = lines.map((line) => {
      const item = byId.get(line.item)!;
      return { id: item.id, qtyPulled: line.qtyPulled, item };
    });

    const moved = await decrementStock(stockLines);

    const transaction = await strapi.documents(TRANSACTIONS_API).create({
      data: {
        orderStatus: "Completed",
        notes,
        custodian: user.id,
        items: lines.map(({ item, qtyPulled }) => ({ item, qtyPulled })),
      },
    });

    await writeStockAuditLogs(user, moved, transaction.id as number);

    await strapi.documents(AUDIT_LOG_API).create({
      data: {
        user: user.id,
        action: "Transaction Issued",
        category: "Transaction",
        target: `#${transaction.id}`,
        detail: `Issued by ${user.username}: ${lines
          .map((line) => {
            const item = byId.get(line.item) as SaleItem | undefined;
            return `${line.qtyPulled} x ${item?.name ?? `#${line.item}`}`;
          })
          .join(", ")}`,
      },
    });

    const created = await loadTransaction(transaction.documentId);

    return { data: created };
  },
};