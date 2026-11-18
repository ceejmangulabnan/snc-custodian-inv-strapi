/**
 * cashier controller
 */

import type { Context } from 'koa'
import type { Knex } from 'knex'

interface SaleItem {
  id: number
  name: string
  sku: string
  stockQty: number
  minThreshold: number
  unit: string
  price: number | null
  isForSale: boolean
}

type SaleItemMap = Record<number, SaleItem>

interface CashierLine {
  item: number
  qtyPulled: number
}

interface TransactionLine {
  id: number
  qtyPulled: number
  item: SaleItem | null
}

interface TransactionEntity {
  id: number
  documentId: string
  type: 'SALE' | 'DEPARTMENT_SUPPLY' | 'DEPARTMENT_BORROW'
  orderStatus: 'Pending' | 'Completed' | 'Voided'
  notes?: string | null
  receiptNumber?: string | null
  studentIdNumber?: string | null
  studentName?: string | null
  purchaseDate?: string | null
  items?: TransactionLine[]
  custodian?: { id: number; username: string } | null
}

interface MovedStock {
  itemId: number
  name: string
  qty: number
  previousStock: number
  newStock: number
  minThreshold: number
}

interface ParsedSalePayload {
  lines: CashierLine[]
  notes: string
  receiptNumber: string
  studentIdNumber: string
  studentName: string
  purchaseDate: string
}

const ITEMS_API = 'api::item.item'
const TRANSACTIONS_API = 'api::transaction.transaction'
const STOCK_MOVEMENT_API = 'api::stock-movement.stock-movement'
const AUDIT_LOG_API = 'api::audit-log.audit-log'

function badRequest(message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number }
  err.status = 400
  return err
}

function parseSalePayload(payload: unknown): ParsedSalePayload {
  const body = (payload ?? {}) as {
    items?: unknown
    notes?: unknown
    receiptNumber?: unknown
    studentIdNumber?: unknown
    studentName?: unknown
    purchaseDate?: unknown
  }

  const lines: CashierLine[] = Array.isArray(body.items)
    ? (body.items as CashierLine[])
    : []

  if (lines.length === 0) {
    throw badRequest('At least one item is required.')
  }

  const notes = typeof body.notes === 'string' ? body.notes.trim() : ''
  const receiptNumber =
    typeof body.receiptNumber === 'string' ? body.receiptNumber.trim() : ''
  const studentIdNumber =
    typeof body.studentIdNumber === 'string' ? body.studentIdNumber.trim() : ''
  const studentName =
    typeof body.studentName === 'string' ? body.studentName.trim() : ''
  const purchaseDate =
    typeof body.purchaseDate === 'string' ? body.purchaseDate.trim() : ''

  if (!receiptNumber) {
    throw badRequest('Receipt number is required.')
  }
  if (!studentIdNumber) {
    throw badRequest('Student ID number is required.')
  }
  if (!studentName) {
    throw badRequest('Student name is required.')
  }
  if (!purchaseDate || Number.isNaN(Date.parse(purchaseDate))) {
    throw badRequest('A valid purchase date is required.')
  }

  for (const line of lines) {
    if (
      !Number.isInteger(line.item) ||
      !Number.isInteger(line.qtyPulled) ||
      line.qtyPulled < 1
    ) {
      throw badRequest(
        'Each line item requires a valid item id and a quantity of at least 1.',
      )
    }
  }

  const ids = [...new Set(lines.map((line) => line.item))]
  if (ids.length !== lines.length) {
    throw badRequest('Duplicate items are not allowed.')
  }

  return {
    lines,
    notes,
    receiptNumber,
    studentIdNumber,
    studentName,
    purchaseDate,
  }
}

async function assertReceiptUnused(receiptNumber: string): Promise<void> {
  const existing = await strapi.documents(TRANSACTIONS_API).findMany({
    filters: { receiptNumber },
    limit: 1,
  })

  if (existing.length > 0) {
    throw badRequest(`Receipt "${receiptNumber}" has already been claimed.`)
  }
}

async function loadItemsByIds(ids: number[]): Promise<SaleItemMap> {
  const existing = await strapi.documents(ITEMS_API).findMany({
    filters: { id: { $in: ids } },
  })

  const byId: SaleItemMap = {}
  for (const item of existing as unknown as SaleItem[]) {
    byId[item.id] = item
  }
  return byId
}

function assertSaleEligibility(lines: CashierLine[], byId: SaleItemMap): void {
  for (const line of lines) {
    const item = byId[line.item]
    if (!item) {
      throw badRequest(`Item #${line.item} does not exist.`)
    }
    if (!item.isForSale) {
      throw badRequest(`"${item.name}" is not available for sale.`)
    }
  }
}

function assertSufficientStock(lines: CashierLine[], byId: SaleItemMap): void {
  for (const line of lines) {
    const item = byId[line.item]
    if (line.qtyPulled > item.stockQty) {
      throw badRequest(`Only ${item.stockQty} of "${item.name}" are in stock.`)
    }
  }
}

async function decrementStockInTrx(
  trx: Knex.Transaction,
  items: TransactionLine[],
): Promise<MovedStock[]> {
  const moved: MovedStock[] = []

  // Lock rows in ascending ID order to prevent PostgreSQL deadlocks
  const sortedItems = [...items].sort((a, b) => a.item!.id - b.item!.id)

  for (const line of sortedItems) {
    const row = await trx('items')
      .where({ id: line.item!.id })
      .forUpdate()
      .first()

    if (!row) {
      throw badRequest(
        `Item "${line.item!.name}" no longer exists in inventory.`,
      )
    }

    if (row.stock_qty < line.qtyPulled) {
      throw badRequest(
        `Not enough stock for "${line.item!.name}" (available: ${row.stock_qty}).`,
      )
    }

    const newStock = row.stock_qty - line.qtyPulled

    await trx('items')
      .where({ id: line.item!.id })
      .update({ stock_qty: newStock })

    moved.push({
      itemId: row.id,
      name: row.name,
      qty: line.qtyPulled,
      previousStock: row.stock_qty,
      newStock,
      minThreshold: row.min_threshold,
    })
  }

  return moved
}

async function recordStockMovementsAndAudits(
  user: { id: number; username: string },
  moved: MovedStock[],
  transactionId: number,
  receiptNumber: string,
): Promise<void> {
  for (const stock of moved) {
    await strapi.documents(STOCK_MOVEMENT_API).create({
      data: {
        item: stock.itemId,
        type: 'Out',
        qty: stock.qty,
        previousStock: stock.previousStock,
        newStock: stock.newStock,
        reason: `Cashier Sale (Receipt #${receiptNumber})`,
        notes: `Transaction #${transactionId}`,
        user: user.id,
      },
    })

    await strapi.documents(AUDIT_LOG_API).create({
      data: {
        user: user.id,
        action: 'Stock Out',
        category: 'Inventory',
        target: stock.name,
        detail: `${stock.qty} unit(s) issued via sale transaction #${transactionId} (Receipt #${receiptNumber}).`,
      },
    })

    if (stock.newStock <= stock.minThreshold) {
      await strapi.documents(AUDIT_LOG_API).create({
        data: {
          user: user.id,
          action: 'Threshold Reached',
          category: 'Inventory',
          target: stock.name,
          detail: `Stock is now ${stock.newStock}, at or below the threshold of ${stock.minThreshold}.`,
        },
      })
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
  })
  const found = result as unknown as TransactionEntity[]

  return found[0] ?? null
}

export default {
  /**
   * List items that cashiers may sell. Only items with isForSale set to true
   * are returned.
   */
  async find(ctx: Context) {
    const user = ctx.state.user as { id: number; username: string } | undefined
    if (!user?.id) {
      throw badRequest('Not authenticated.')
    }

    const saleItems = await strapi.documents(ITEMS_API).findMany({
      filters: { isForSale: true },
    })

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
    }
  },

  /**
   * Issue stock for a sale in a single atomic transaction: lock & decrement
   * inventory, create a Completed SALE transaction, record stock movements,
   * and write audit logs.
   */
  async issue(ctx: Context) {
    const user = ctx.state.user as { id: number; username: string } | undefined
    if (!user?.id) {
      throw badRequest('Not authenticated.')
    }

    // 1. Validate inputs & pre-flight checks outside the DB transaction
    const {
      lines,
      notes,
      receiptNumber,
      studentIdNumber,
      studentName,
      purchaseDate,
    } = parseSalePayload(ctx.request.body)

    await assertReceiptUnused(receiptNumber)

    const byId = await loadItemsByIds(lines.map((line) => line.item))
    assertSaleEligibility(lines, byId)
    assertSufficientStock(lines, byId)

    const stockLines: TransactionLine[] = lines.map((line) => {
      const item = byId[line.item]
      return { id: item.id, qtyPulled: line.qtyPulled, item }
    })

    // 2. Execute all writes inside one atomic Strapi 5 DB transaction
    const createdDocumentId = await strapi.db.transaction(async ({ trx }) => {
      const moved = await decrementStockInTrx(trx, stockLines)

      const transaction = await strapi.documents(TRANSACTIONS_API).create({
        data: {
          type: 'SALE',
          orderStatus: 'Completed',
          notes,
          receiptNumber,
          studentIdNumber,
          studentName,
          purchaseDate: new Date(purchaseDate).toISOString(),
          custodian: user.id,
          items: lines.map(({ item, qtyPulled }) => ({ item, qtyPulled })),
        },
      })

      await recordStockMovementsAndAudits(
        user,
        moved,
        transaction.id as number,
        receiptNumber,
      )

      await strapi.documents(AUDIT_LOG_API).create({
        data: {
          user: user.id,
          action: 'Transaction Issued',
          category: 'Transaction',
          target: `#${transaction.id}`,
          detail: `Sale (Receipt #${receiptNumber}) issued by ${user.username} to ${studentName} (${studentIdNumber}): ${lines
            .map((line) => {
              const item = byId[line.item]
              return `${line.qtyPulled} x ${item?.name ?? `#${line.item}`}`
            })
            .join(', ')}`,
        },
      })

      return transaction.documentId
    })

    // 3. Re-fetch populated transaction after commit
    const created = await loadTransaction(createdDocumentId)

    return { data: created }
  },
}
