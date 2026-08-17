/**
 * transaction controller
 */

import { factories } from '@strapi/strapi';
import type { Context } from 'koa';

interface RequestedLine {
  item: number;
  qtyPulled: number;
}

interface InventoryItem {
  id: number;
  name: string;
  sku: string;
  stockQty: number;
  minThreshold: number;
  unit: string;
}

interface TransactionLine {
  id: number;
  qtyPulled: number;
  item: InventoryItem | null;
}

interface TransactionEntity {
  id: number;
  documentId: string;
  orderStatus: 'Pending' | 'Completed' | 'Voided';
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

async function loadTransaction(
  documentId: string
): Promise<TransactionEntity | null> {
  const result = await strapi.entityService.findMany(
    'api::transaction.transaction',
    {
      filters: { documentId } as never,
      populate: {
        custodian: true,
        items: { populate: { item: true } },
      },
    }
  );
  const found = result as unknown as TransactionEntity[];

  return found[0] ?? null;
}

function badRequest(message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

function isBadRequest(err: unknown): err is Error {
  return (err as { status?: number })?.status === 400;
}

function summarize(items: TransactionLine[]): string {
  return items
    .map((line) => `${line.qtyPulled} x ${line.item?.name ?? `#${line.id}`}`)
    .join(', ');
}

function parseRequestedLines(payload: unknown): {
  lines: RequestedLine[];
  notes: string;
} {
  const body = (payload ?? {}) as { items?: unknown; notes?: unknown };
  const lines: RequestedLine[] = Array.isArray(body.items)
    ? (body.items as RequestedLine[])
    : [];

  if (lines.length === 0) {
    throw badRequest('At least one item is required.');
  }

  const notes = typeof body.notes === 'string' ? body.notes.trim() : '';

  for (const line of lines) {
    if (
      !Number.isInteger(line.item) ||
      !Number.isInteger(line.qtyPulled) ||
      line.qtyPulled < 1
    ) {
      throw badRequest(
        'Each line item requires a valid item id and a quantity of at least 1.'
      );
    }
  }

  const ids = [...new Set(lines.map((line) => line.item))];
  if (ids.length !== lines.length) {
    throw badRequest('Duplicate items are not allowed.');
  }

  return { lines, notes };
}

async function loadItemsByIds(
  ids: number[]
): Promise<Map<number, InventoryItem>> {
  const existing = await strapi.entityService.findMany('api::item.item', {
    filters: { id: { $in: ids } },
  });

  return new Map(
    existing.map((item) => [
      item.id as number,
      item as unknown as InventoryItem,
    ])
  );
}

function assertSufficientStock(
  lines: RequestedLine[],
  byId: Map<number, InventoryItem>
): void {
  for (const line of lines) {
    const item = byId.get(line.item);
    if (!item) {
      throw badRequest(`Item #${line.item} does not exist.`);
    }
    if (line.qtyPulled > item.stockQty) {
      throw badRequest(`Only ${item.stockQty} of "${item.name}" are in stock.`);
    }
  }
}

async function decrementStock(items: TransactionLine[]): Promise<MovedStock[]> {
  const moved: MovedStock[] = [];

  await strapi.db.transaction(async ({ trx }) => {
    for (const line of items) {
      const row = await trx('items')
        .where({ id: line.item!.id })
        .forUpdate()
        .first();

      if (!row) {
        throw badRequest(
          `Item "${line.item!.name}" no longer exists in inventory.`
        );
      }

      if (row.stock_qty < line.qtyPulled) {
        throw badRequest(
          `Not enough stock for "${line.item!.name}" (available: ${row.stock_qty}).`
        );
      }

      await trx('items')
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
  transactionId: number
): Promise<void> {
  for (const stock of moved) {
    await strapi.entityService.create('api::audit-log.audit-log', {
      data: {
        user: user.id,
        action: 'Stock Out',
        category: 'Inventory',
        target: stock.name,
        detail: `${stock.qty} unit(s) issued via transaction #${transactionId}.`,
      },
    });

    if (stock.stockQty <= stock.minThreshold) {
      await strapi.entityService.create('api::audit-log.audit-log', {
        data: {
          user: user.id,
          action: 'Threshold Reached',
          category: 'Inventory',
          target: stock.name,
          detail: `Stock is now ${stock.stockQty}, at or below the threshold of ${stock.minThreshold}.`,
        },
      });
    }
  }
}

function runAction(
  handler: (ctx: Context) => Promise<unknown>
): (ctx: Context) => Promise<unknown> {
  return async (ctx: Context) => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (isBadRequest(err)) {
        return ctx.badRequest(err.message);
      }
      throw err;
    }
  };
}

export default factories.createCoreController('api::transaction.transaction', () => ({
  /**
   * Create a Pending transaction on behalf of the authenticated user.
   * Body: { items: [{ item: <id>, qtyPulled: <int> }], notes?: string }
   */
  request: runAction(async (ctx: Context) => {
    const user = ctx.state.user as { id: number; username: string } | undefined;
    if (!user?.id) {
      throw badRequest('Not authenticated.');
    }

    const { lines, notes } = parseRequestedLines(ctx.request.body);
    const byId = await loadItemsByIds(lines.map((line) => line.item));
    assertSufficientStock(lines, byId);

    const transaction = await strapi.entityService.create(
      'api::transaction.transaction',
      {
        data: {
          orderStatus: 'Pending',
          notes,
          custodian: user.id,
          items: lines.map(({ item, qtyPulled }) => ({ item, qtyPulled })),
        },
      }
    );

    await strapi.entityService.create('api::audit-log.audit-log', {
      data: {
        user: user.id,
        action: 'Transaction Created',
        category: 'Transaction',
        target: `#${transaction.id}`,
        detail: `Requested by ${user.username}: ${lines
          .map((line) => {
            const item = byId.get(line.item) as InventoryItem | undefined;
            return `${line.qtyPulled} x ${item?.name ?? `#${line.item}`}`;
          })
          .join(', ')}`,
      },
    });

    const created = await loadTransaction(transaction.documentId);

    return { data: created };
  }),

  /**
   * Issue stock in a single step: atomically decrement inventory and create a
   * Completed transaction for the authenticated user. Requires the Custodian
   * or Administrator role (permission-gated).
   */
  issue: runAction(async (ctx: Context) => {
    const user = ctx.state.user as { id: number; username: string } | undefined;
    if (!user?.id) {
      throw badRequest('Not authenticated.');
    }

    const { lines, notes } = parseRequestedLines(ctx.request.body);
    const byId = await loadItemsByIds(lines.map((line) => line.item));
    assertSufficientStock(lines, byId);

    const stockLines: TransactionLine[] = lines.map((line) => {
      const item = byId.get(line.item)!;
      return { id: item.id, qtyPulled: line.qtyPulled, item };
    });

    const moved = await decrementStock(stockLines);

    const transaction = await strapi.entityService.create(
      'api::transaction.transaction',
      {
        data: {
          orderStatus: 'Completed',
          notes,
          custodian: user.id,
          items: lines.map(({ item, qtyPulled }) => ({ item, qtyPulled })),
        },
      }
    );

    await writeStockAuditLogs(user, moved, transaction.id as number);

    await strapi.entityService.create('api::audit-log.audit-log', {
      data: {
        user: user.id,
        action: 'Transaction Issued',
        category: 'Transaction',
        target: `#${transaction.id}`,
        detail: `Issued by ${user.username}: ${lines
          .map((line) => {
            const item = byId.get(line.item) as InventoryItem | undefined;
            return `${line.qtyPulled} x ${item?.name ?? `#${line.item}`}`;
          })
          .join(', ')}`,
      },
    });

    const created = await loadTransaction(transaction.documentId);

    return { data: created };
  }),

  /**
   * Complete a Pending transaction: decrement stock atomically, then write
   * audit logs. Requires the Administrator role (permission-gated).
   */
  complete: runAction(async (ctx: Context) => {
    const documentId = ctx.params.documentId as string;

    const transaction = await loadTransaction(documentId);

    if (!transaction) {
      throw badRequest('Transaction not found.');
    }

    if (transaction.orderStatus !== 'Pending') {
      throw badRequest('Only pending transactions can be completed.');
    }

    const items: TransactionLine[] = transaction.items ?? [];
    if (items.length === 0) {
      throw badRequest('Transaction has no items.');
    }

    for (const line of items) {
      if (!line.item) {
        throw badRequest(
          `A line item no longer exists in inventory (was: #${line.id}).`
        );
      }
    }

    const moved = await decrementStock(items);

    const admin = ctx.state.user as { id: number; username: string } | undefined;

    await strapi.entityService.update('api::transaction.transaction', transaction.id, {
      data: { orderStatus: 'Completed' },
    });

    if (admin?.id) {
      await writeStockAuditLogs(admin, moved, transaction.id);

      await strapi.entityService.create('api::audit-log.audit-log', {
        data: {
          user: admin.id,
          action: 'Transaction Completed',
          category: 'Transaction',
          target: `#${transaction.id}`,
          detail: summarize(items),
        },
      });
    }

    const updated = await loadTransaction(transaction.documentId);

    return { data: updated };
  }),

  /**
   * Void a Pending transaction without touching stock. Requires the
   * Administrator role (permission-gated).
   */
  void: runAction(async (ctx: Context) => {
    const documentId = ctx.params.documentId as string;

    const transaction = await loadTransaction(documentId);

    if (!transaction) {
      throw badRequest('Transaction not found.');
    }

    if (transaction.orderStatus !== 'Pending') {
      throw badRequest('Only pending transactions can be voided.');
    }

    const admin = ctx.state.user as { id: number; username: string } | undefined;

    await strapi.entityService.update('api::transaction.transaction', transaction.id, {
      data: { orderStatus: 'Voided' },
    });

    if (admin?.id) {
      await strapi.entityService.create('api::audit-log.audit-log', {
        data: {
          user: admin.id,
          action: 'Transaction Voided',
          category: 'Transaction',
          target: `#${transaction.id}`,
          detail: summarize(transaction.items ?? []),
        },
      });
    }

    const updated = await loadTransaction(transaction.documentId);

    return { data: updated };
  }),
}));
