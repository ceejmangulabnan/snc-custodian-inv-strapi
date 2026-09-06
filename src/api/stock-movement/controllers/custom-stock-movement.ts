/**
 * custom stock-movement controller
 *
 * Internal inventory movements (receiving, disbursement, corrections).
 * Tracked separately from sales transactions.
 * */

import type { Context } from "koa";

interface InventoryItem {
  id: number;
  name: string;
  sku: string;
  stockQty: number;
  minThreshold: number;
}

interface StockUser {
  id: number;
  username: string;
}

const ITEMS_API = "api::item.item";
const STOCK_MOVEMENTS_API = "api::stock-movement.stock-movement";
const AUDIT_LOG_API = "api::audit-log.audit-log";

function badRequest(message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

async function loadItemById(id: number): Promise<InventoryItem | null> {
  const result = await strapi.documents(ITEMS_API).findMany({
    filters: { id } as never,
  });

  return (result[0] as unknown as InventoryItem) ?? null;
}

/**
 * Atomically mutate stockQty on the items table, returning the row for
 * audit/ledger purposes. When mode is "set", `value` is the absolute target
 * quantity; when mode is "delta", `value` is added to the current quantity.
 * Throws a 400 when the resulting quantity would go negative.
 */
async function applyStockChange(
  item: InventoryItem,
  mode: "delta" | "set",
  value: number,
): Promise<{ previousStock: number; newStock: number; minThreshold: number }> {
  let previousStock = 0;
  let minThreshold = 0;
  let newStock = 0;

  await strapi.db.transaction(async ({ trx }) => {
    const row = await trx("items").where({ id: item.id }).forUpdate().first();

    if (!row) {
      throw badRequest(`Item "${item.name}" no longer exists in inventory.`);
    }

    const current = Number(row.stock_qty ?? 0);
    const next = mode === "set" ? value : current + value;

    if (next < 0) {
      throw badRequest(
        `Not enough stock for "${row.name}" (available: ${current}).`,
      );
    }

    await trx("items").where({ id: item.id }).update({ stock_qty: next });

    previousStock = current;
    newStock = next;
    minThreshold = Number(row.min_threshold ?? 0);
  });

  return { previousStock, newStock, minThreshold };
}

async function writeLedger(
  user: StockUser,
  data: {
    item: number;
    type: "In" | "Out" | "Adjustment";
    qty: number;
    previousStock: number;
    newStock: number;
    reason?: string;
    notes?: string;
  },
): Promise<unknown> {
  return strapi.documents(STOCK_MOVEMENTS_API).create({
    data: {
      item: data.item,
      type: data.type,
      qty: data.qty,
      previousStock: data.previousStock,
      newStock: data.newStock,
      reason: data.reason,
      notes: data.notes,
      user: user.id,
    },
  });
}

async function writeAuditLog(
  user: StockUser,
  data: {
    action: "Stock In" | "Stock Out" | "Stock Adjusted" | "Threshold Reached";
    item: string;
    detail: string;
  },
): Promise<void> {
  await strapi.documents(AUDIT_LOG_API).create({
    data: {
      user: user.id,
      action: data.action,
      category: "Inventory",
      target: data.item,
      detail: data.detail,
    },
  });
}

async function writeThresholdLog(
  user: StockUser,
  itemName: string,
  newStock: number,
  minThreshold: number,
): Promise<void> {
  if (newStock <= minThreshold) {
    await writeAuditLog(user, {
      action: "Threshold Reached",
      item: itemName,
      detail: `Stock is now ${newStock}, at or below the threshold of ${minThreshold}.`,
    });
  }
}

function parseMovementPayload(payload: unknown): {
  item: number;
  qty: number;
  reason?: string;
  notes?: string;
} {
  const body = (payload ?? {}) as {
    item?: unknown;
    qty?: unknown;
    reason?: unknown;
    notes?: unknown;
  };

  if (!Number.isInteger(body.item)) {
    throw badRequest("A valid item id is required.");
  }
  if (!Number.isInteger(body.qty) || (body.qty as number) < 1) {
    throw badRequest("A valid quantity of at least 1 is required.");
  }

  const reason =
    typeof body.reason === "string" ? body.reason.trim() : undefined;
  const notes = typeof body.notes === "string" ? body.notes.trim() : undefined;

  return {
    item: body.item as number,
    qty: body.qty as number,
    reason: reason || undefined,
    notes: notes || undefined,
  };
}

function getCtxUser(ctx: Context): StockUser {
  const user = ctx.state.user as StockUser | undefined;
  if (!user?.id) {
    throw badRequest("Not authenticated.");
  }
  return user;
}

export default {
  /**
   * Receive stock into inventory.
   * Body: { item: <id>, qty: <int>, reason?: string, notes?: string }
   */
  async stockIn(ctx: Context) {
    const user = getCtxUser(ctx);
    const { item, qty, reason, notes } = parseMovementPayload(ctx.request.body);

    const existing = await loadItemById(item);
    if (!existing) {
      throw badRequest(`Item #${item} does not exist.`);
    }

    const { previousStock, newStock, minThreshold } = await applyStockChange(
      existing,
      "delta",
      qty,
    );

    await writeLedger(user, {
      item,
      type: "In",
      qty,
      previousStock,
      newStock,
      reason,
      notes,
    });

    await writeAuditLog(user, {
      action: "Stock In",
      item: existing.name,
      detail: `${qty} unit(s) received. Stock: ${previousStock} -> ${newStock}.`,
    });

    return { data: { item: existing.id, previousStock, newStock } };
  },

  /**
   * Disburse stock internally (non-sales movement).
   * Body: { item: <id>, qty: <int>, reason?: string, notes?: string }
   */
  async stockOut(ctx: Context) {
    const user = getCtxUser(ctx);
    const { item, qty, reason, notes } = parseMovementPayload(ctx.request.body);

    const existing = await loadItemById(item);
    if (!existing) {
      throw badRequest(`Item #${item} does not exist.`);
    }

    const { previousStock, newStock, minThreshold } = await applyStockChange(
      existing,
      "delta",
      -qty,
    );

    await writeLedger(user, {
      item,
      type: "Out",
      qty,
      previousStock,
      newStock,
      reason,
      notes,
    });

    await writeAuditLog(user, {
      action: "Stock Out",
      item: existing.name,
      detail: `${qty} unit(s) disbursed. Stock: ${previousStock} -> ${newStock}.`,
    });

    await writeThresholdLog(user, existing.name, newStock, minThreshold);

    return { data: { item: existing.id, previousStock, newStock } };
  },

  /**
   * Set stock to an absolute target quantity.
   * Body: { item: <id>, newQty: <int>, reason?: string, notes?: string }
   */
  async adjust(ctx: Context) {
    const user = getCtxUser(ctx);

    const body = (ctx.request.body ?? {}) as {
      item?: unknown;
      newQty?: unknown;
      reason?: unknown;
      notes?: unknown;
    };

    if (!Number.isInteger(body.item)) {
      throw badRequest("A valid item id is required.");
    }
    if (!Number.isInteger(body.newQty) || (body.newQty as number) < 0) {
      throw badRequest("A valid non-negative target quantity is required.");
    }

    const item = body.item as number;
    const newQty = body.newQty as number;
    const reason =
      typeof body.reason === "string" ? body.reason.trim() : undefined;
    const notes =
      typeof body.notes === "string" ? body.notes.trim() : undefined;

    const existing = await loadItemById(item);
    if (!existing) {
      throw badRequest(`Item #${item} does not exist.`);
    }

    const { previousStock, minThreshold } = await applyStockChange(
      existing,
      "set",
      newQty,
    );

    const adjusted = newQty;

    await writeLedger(user, {
      item,
      type: "Adjustment",
      qty: Math.abs(adjusted - previousStock),
      previousStock,
      newStock: adjusted,
      reason,
      notes,
    });

    await writeAuditLog(user, {
      action: "Stock Adjusted",
      item: existing.name,
      detail: `Stock adjusted: ${previousStock} -> ${adjusted}.`,
    });

    await writeThresholdLog(user, existing.name, adjusted, minThreshold);

    return { data: { item: existing.id, previousStock, newStock: adjusted } };
  },
};
