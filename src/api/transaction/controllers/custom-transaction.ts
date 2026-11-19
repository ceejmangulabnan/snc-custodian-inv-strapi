/**
 * custom transaction controller
 */

import type { Context } from 'koa'
import type { Knex } from 'knex'

type CustodianTransactionType = 'DEPARTMENT_SUPPLY' | 'DEPARTMENT_BORROW'

interface RequestedLine {
    item: number
    qtyPulled: number
}

interface InventoryItem {
    id: number
    name: string
    sku: string
    stockQty: number
    minThreshold: number
    unit: string
}

type InventoryItemMap = Record<number, InventoryItem>

interface TransactionLine {
    id: number
    qtyPulled: number
    item: InventoryItem | null
}

interface TransactionEntity {
    id: number
    documentId: string
    type: 'SALE' | CustodianTransactionType
    orderStatus: 'Pending' | 'Completed' | 'Voided'
    notes?: string | null
    departmentName?: string | null
    borrowerName?: string | null
    returnDate?: string | null
    isReturned?: boolean | null
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

interface ParsedCustodianPayload {
    type: CustodianTransactionType
    lines: RequestedLine[]
    notes: string
    departmentName: string
    borrowerName: string
    returnDate?: string
}

const ITEMS_API = 'api::item.item'
const TRANSACTIONS_API = 'api::transaction.transaction'
const STOCK_MOVEMENT_API = 'api::stock-movement.stock-movement'
const AUDIT_LOG_API = 'api::audit-log.audit-log'

async function loadTransaction(
    documentId: string
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

function badRequest(message: string): Error & { status: number } {
    const err = new Error(message) as Error & { status: number }
    err.status = 400
    return err
}

function summarize(items: TransactionLine[]): string {
    return items
        .map(
            (line) => `${line.qtyPulled} x ${line.item?.name ?? `#${line.id}`}`
        )
        .join(', ')
}

function formatDepartmentContext(tx: {
    type: string
    departmentName?: string | null
    borrowerName?: string | null
}): string {
    const label = tx.type === 'DEPARTMENT_BORROW' ? 'Borrow' : 'Supply'
    const dept = tx.departmentName ? ` (${tx.departmentName}` : ''
    const borrower = tx.borrowerName
        ? `${dept ? ` - ${tx.borrowerName})` : ` (${tx.borrowerName})`}`
        : dept
          ? ')'
          : ''
    return `${label}${dept}${borrower}`
}

function parseCustodianPayload(payload: unknown): ParsedCustodianPayload {
    const body = (payload ?? {}) as {
        type?: unknown
        items?: unknown
        notes?: unknown
        departmentName?: unknown
        borrowerName?: unknown
        returnDate?: unknown
    }

    if (body.type === 'SALE') {
        throw badRequest(
            'Sale transactions must be processed through the cashier endpoint.'
        )
    }

    const type: CustodianTransactionType =
        body.type === 'DEPARTMENT_BORROW'
            ? 'DEPARTMENT_BORROW'
            : 'DEPARTMENT_SUPPLY'

    const lines: RequestedLine[] = Array.isArray(body.items)
        ? (body.items as RequestedLine[])
        : []

    if (lines.length === 0) {
        throw badRequest('At least one item is required.')
    }

    const notes = typeof body.notes === 'string' ? body.notes.trim() : ''
    const departmentName =
        typeof body.departmentName === 'string'
            ? body.departmentName.trim()
            : ''
    const borrowerName =
        typeof body.borrowerName === 'string' ? body.borrowerName.trim() : ''
    const rawReturnDate =
        typeof body.returnDate === 'string' ? body.returnDate.trim() : ''

    if (!departmentName) {
        throw badRequest('Department name is required.')
    }
    if (!borrowerName) {
        throw badRequest('Borrower or recipient name is required.')
    }

    let returnDate: string | undefined
    if (type === 'DEPARTMENT_BORROW') {
        if (!rawReturnDate || Number.isNaN(Date.parse(rawReturnDate))) {
            throw badRequest(
                'A valid expected return date is required for borrowed items.'
            )
        }
        returnDate = new Date(rawReturnDate).toISOString()
    }

    for (const line of lines) {
        if (
            !Number.isInteger(line.item) ||
            !Number.isInteger(line.qtyPulled) ||
            line.qtyPulled < 1
        ) {
            throw badRequest(
                'Each line item requires a valid item id and a quantity of at least 1.'
            )
        }
    }

    const ids = [...new Set(lines.map((line) => line.item))]
    if (ids.length !== lines.length) {
        throw badRequest('Duplicate items are not allowed.')
    }

    return {
        type,
        lines,
        notes,
        departmentName,
        borrowerName,
        returnDate,
    }
}

async function loadItemsByIds(ids: number[]): Promise<InventoryItemMap> {
    const existing = await strapi.documents(ITEMS_API).findMany({
        filters: { id: { $in: ids } },
    })

    const byId: InventoryItemMap = {}
    for (const item of existing as unknown as InventoryItem[]) {
        byId[item.id] = item
    }
    return byId
}

function assertSufficientStock(
    lines: RequestedLine[],
    byId: InventoryItemMap
): void {
    for (const line of lines) {
        const item = byId[line.item]
        if (!item) {
            throw badRequest(`Item #${line.item} does not exist.`)
        }
        if (line.qtyPulled > item.stockQty) {
            throw badRequest(
                `Only ${item.stockQty} of "${item.name}" are in stock.`
            )
        }
    }
}

async function decrementStockInTrx(
    trx: Knex.Transaction,
    items: TransactionLine[]
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
                `Item "${line.item!.name}" no longer exists in inventory.`
            )
        }

        if (row.stock_qty < line.qtyPulled) {
            throw badRequest(
                `Not enough stock for "${line.item!.name}" (available: ${row.stock_qty}).`
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

async function incrementStockInTrx(
    trx: Knex.Transaction,
    items: TransactionLine[]
): Promise<MovedStock[]> {
    const moved: MovedStock[] = []

    const sortedItems = [...items].sort((a, b) => a.item!.id - b.item!.id)

    for (const line of sortedItems) {
        const row = await trx('items')
            .where({ id: line.item!.id })
            .forUpdate()
            .first()

        if (!row) {
            throw badRequest(
                `Item "${line.item!.name}" no longer exists in inventory.`
            )
        }

        const newStock = row.stock_qty + line.qtyPulled

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

async function recordStockOutAndAudits(
    user: { id: number; username: string },
    moved: MovedStock[],
    transactionId: number,
    reasonLabel: string
): Promise<void> {
    for (const stock of moved) {
        await strapi.documents(STOCK_MOVEMENT_API).create({
            data: {
                item: stock.itemId,
                type: 'Out',
                qty: stock.qty,
                previousStock: stock.previousStock,
                newStock: stock.newStock,
                reason: reasonLabel,
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
                detail: `${stock.qty} unit(s) issued via transaction #${transactionId} (${reasonLabel}).`,
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

export default {
    /**
     * Create a Pending department transaction (supply or borrow) without deducting stock.
     * Body: {
     *   type?: "DEPARTMENT_SUPPLY" | "DEPARTMENT_BORROW",
     *   departmentName: string,
     *   borrowerName: string,
     *   returnDate?: string (required if DEPARTMENT_BORROW),
     *   items: [{ item: <id>, qtyPulled: <int> }],
     *   notes?: string
     * }
     */
    async request(ctx: Context) {
        const user = ctx.state.user as
            { id: number; username: string } | undefined
        if (!user?.id) {
            throw badRequest('Not authenticated.')
        }

        const { type, lines, notes, departmentName, borrowerName, returnDate } =
            parseCustodianPayload(ctx.request.body)

        const byId = await loadItemsByIds(lines.map((line) => line.item))
        assertSufficientStock(lines, byId)

        const createdDocumentId = await strapi.db.transaction(async () => {
            const transaction = await strapi
                .documents(TRANSACTIONS_API)
                .create({
                    data: {
                        type,
                        orderStatus: 'Pending',
                        notes,
                        departmentName,
                        borrowerName,
                        ...(returnDate
                            ? { returnDate, isReturned: false }
                            : {}),
                        custodian: user.id,
                        items: lines.map(({ item, qtyPulled }) => ({
                            item,
                            qtyPulled,
                        })),
                    },
                })

            const contextLabel = formatDepartmentContext({
                type,
                departmentName,
                borrowerName,
            })

            await strapi.documents(AUDIT_LOG_API).create({
                data: {
                    user: user.id,
                    action: 'Transaction Created',
                    category: 'Transaction',
                    target: `#${transaction.id}`,
                    detail: `${contextLabel} requested by ${user.username}: ${lines
                        .map((line) => {
                            const item = byId[line.item]
                            return `${line.qtyPulled} x ${item?.name ?? `#${line.item}`}`
                        })
                        .join(', ')}`,
                },
            })

            return transaction.documentId
        })

        const created = await loadTransaction(createdDocumentId)

        return { data: created }
    },

    /**
     * Issue stock in a single atomic step: decrement inventory and create a
     * Completed department supply or borrow transaction.
     */
    async issue(ctx: Context) {
        const user = ctx.state.user as
            { id: number; username: string } | undefined
        if (!user?.id) {
            throw badRequest('Not authenticated.')
        }

        const { type, lines, notes, departmentName, borrowerName, returnDate } =
            parseCustodianPayload(ctx.request.body)

        const byId = await loadItemsByIds(lines.map((line) => line.item))
        assertSufficientStock(lines, byId)

        const stockLines: TransactionLine[] = lines.map((line) => {
            const item = byId[line.item]
            return { id: item.id, qtyPulled: line.qtyPulled, item }
        })

        const reasonLabel = formatDepartmentContext({
            type,
            departmentName,
            borrowerName,
        })

        const createdDocumentId = await strapi.db.transaction(
            async ({ trx }) => {
                const moved = await decrementStockInTrx(trx, stockLines)

                const transaction = await strapi
                    .documents(TRANSACTIONS_API)
                    .create({
                        data: {
                            type,
                            orderStatus: 'Completed',
                            notes,
                            departmentName,
                            borrowerName,
                            ...(returnDate
                                ? { returnDate, isReturned: false }
                                : {}),
                            custodian: user.id,
                            items: lines.map(({ item, qtyPulled }) => ({
                                item,
                                qtyPulled,
                            })),
                        },
                    })

                await recordStockOutAndAudits(
                    user,
                    moved,
                    transaction.id as number,
                    reasonLabel
                )

                await strapi.documents(AUDIT_LOG_API).create({
                    data: {
                        user: user.id,
                        action: 'Transaction Issued',
                        category: 'Transaction',
                        target: `#${transaction.id}`,
                        detail: `${reasonLabel} issued by ${user.username}: ${lines
                            .map((line) => {
                                const item = byId[line.item]
                                return `${line.qtyPulled} x ${item?.name ?? `#${line.item}`}`
                            })
                            .join(', ')}`,
                    },
                })

                return transaction.documentId
            }
        )

        const created = await loadTransaction(createdDocumentId)

        return { data: created }
    },

    /**
     * Complete a Pending transaction: atomically decrement stock, update status,
     * record stock movements, and write audit logs.
     */
    async complete(ctx: Context) {
        const documentId = ctx.params.documentId as string

        const transaction = await loadTransaction(documentId)

        if (!transaction) {
            throw badRequest('Transaction not found.')
        }

        if (transaction.orderStatus !== 'Pending') {
            throw badRequest('Only pending transactions can be completed.')
        }

        const items: TransactionLine[] = transaction.items ?? []
        if (items.length === 0) {
            throw badRequest('Transaction has no items.')
        }

        for (const line of items) {
            if (!line.item) {
                throw badRequest(
                    `A line item no longer exists in inventory (was: #${line.id}).`
                )
            }
        }

        const admin = ctx.state.user as
            { id: number; username: string } | undefined

        const reasonLabel = formatDepartmentContext(transaction)

        await strapi.db.transaction(async ({ trx }) => {
            const moved = await decrementStockInTrx(trx, items)

            await strapi.documents(TRANSACTIONS_API).update({
                documentId: transaction.documentId,
                data: { orderStatus: 'Completed' },
            })

            if (admin?.id) {
                await recordStockOutAndAudits(
                    admin,
                    moved,
                    transaction.id,
                    reasonLabel
                )

                await strapi.documents(AUDIT_LOG_API).create({
                    data: {
                        user: admin.id,
                        action: 'Transaction Completed',
                        category: 'Transaction',
                        target: `#${transaction.id}`,
                        detail: `${reasonLabel}: ${summarize(items)}`,
                    },
                })
            }
        })

        const updated = await loadTransaction(transaction.documentId)

        return { data: updated }
    },

    /**
     * Return borrowed items from a Completed DEPARTMENT_BORROW transaction:
     * atomically increments stock back, marks isReturned = true, and logs Stock In.
     */
    async returnBorrowed(ctx: Context) {
        const user = ctx.state.user as
            { id: number; username: string } | undefined
        if (!user?.id) {
            throw badRequest('Not authenticated.')
        }

        const documentId = ctx.params.documentId as string
        const transaction = await loadTransaction(documentId)

        if (!transaction) {
            throw badRequest('Transaction not found.')
        }

        if (transaction.type !== 'DEPARTMENT_BORROW') {
            throw badRequest(
                'Only borrowed department transactions can be returned.'
            )
        }

        if (transaction.orderStatus !== 'Completed') {
            throw badRequest(
                'Only completed borrow transactions can be marked as returned.'
            )
        }

        if (transaction.isReturned) {
            throw badRequest(
                'This borrowed transaction has already been returned.'
            )
        }

        const items: TransactionLine[] = transaction.items ?? []
        if (items.length === 0) {
            throw badRequest('Transaction has no items.')
        }

        for (const line of items) {
            if (!line.item) {
                throw badRequest(
                    `A line item no longer exists in inventory (was: #${line.id}).`
                )
            }
        }

        const reasonLabel = `Return from ${transaction.departmentName ?? 'Department'}${
            transaction.borrowerName ? ` (${transaction.borrowerName})` : ''
        }`

        await strapi.db.transaction(async ({ trx }) => {
            const moved = await incrementStockInTrx(trx, items)

            await strapi.documents(TRANSACTIONS_API).update({
                documentId: transaction.documentId,
                data: { isReturned: true },
            })

            for (const stock of moved) {
                await strapi.documents(STOCK_MOVEMENT_API).create({
                    data: {
                        item: stock.itemId,
                        type: 'In',
                        qty: stock.qty,
                        previousStock: stock.previousStock,
                        newStock: stock.newStock,
                        reason: reasonLabel,
                        notes: `Return for Transaction #${transaction.id}`,
                        user: user.id,
                    },
                })

                await strapi.documents(AUDIT_LOG_API).create({
                    data: {
                        user: user.id,
                        action: 'Stock In',
                        category: 'Inventory',
                        target: stock.name,
                        detail: `${stock.qty} unit(s) returned via transaction #${transaction.id} (${reasonLabel}).`,
                    },
                })
            }
        })

        const updated = await loadTransaction(transaction.documentId)

        return { data: updated }
    },

    /**
     * Void a Pending transaction without touching stock. Requires the
     * Administrator role (permission-gated).
     */
    async void(ctx: Context) {
        const documentId = ctx.params.documentId as string

        const transaction = await loadTransaction(documentId)

        if (!transaction) {
            throw badRequest('Transaction not found.')
        }

        if (transaction.orderStatus !== 'Pending') {
            throw badRequest('Only pending transactions can be voided.')
        }

        const admin = ctx.state.user as
            { id: number; username: string } | undefined

        await strapi.db.transaction(async () => {
            await strapi.documents(TRANSACTIONS_API).update({
                documentId: transaction.documentId,
                data: { orderStatus: 'Voided' },
            })

            if (admin?.id) {
                await strapi.documents(AUDIT_LOG_API).create({
                    data: {
                        user: admin.id,
                        action: 'Transaction Voided',
                        category: 'Transaction',
                        target: `#${transaction.id}`,
                        detail: summarize(transaction.items ?? []),
                    },
                })
            }
        })

        const updated = await loadTransaction(transaction.documentId)

        return { data: updated }
    },

    async cashierGet(ctx: Context) {
        const role = ctx.state.user.role.type
        return { role }
    },
}

// export default factories.createCoreController(
//   "api::transaction.transaction",
//   () => ({
//     /**
//      * Create a Pending transaction on behalf of the authenticated user.
//      * Body: { items: [{ item: <id>, qtyPulled: <int> }], notes?: string }
//      */
//     request: runAction(async (ctx: Context) => {
//       const user = ctx.state.user as
//         | { id: number; username: string }
//         | undefined;
//       if (!user?.id) {
//         throw badRequest("Not authenticated.");
//       }
//
//       const { lines, notes } = parseRequestedLines(ctx.request.body);
//       const byId = await loadItemsByIds(lines.map((line) => line.item));
//       assertSufficientStock(lines, byId);
//
//       const transaction = await strapi.documents(TRANSACTIONS_API).create({
//         data: {
//           orderStatus: "Pending",
//           notes,
//           custodian: user.id,
//           items: lines.map(({ item, qtyPulled }) => ({ item, qtyPulled })),
//         },
//       });
//
//       await strapi.documents(AUDIT_LOG_API).create({
//         data: {
//           user: user.id,
//           action: "Transaction Created",
//           category: "Transaction",
//           target: `#${transaction.id}`,
//           detail: `Requested by ${user.username}: ${lines
//             .map((line) => {
//               const item = byId.get(line.item) as InventoryItem | undefined;
//               return `${line.qtyPulled} x ${item?.name ?? `#${line.item}`}`;
//             })
//             .join(", ")}`,
//         },
//       });
//
//       const created = await loadTransaction(transaction.documentId);
//
//       return { data: created };
//     }),
//
//     /**
//      * Issue stock in a single step: atomically decrement inventory and create a
//      * Completed transaction for the authenticated user. Requires the Custodian
//      * or Administrator role (permission-gated).
//      */
//     issue: runAction(async (ctx: Context) => {
//       const user = ctx.state.user as
//         | { id: number; username: string }
//         | undefined;
//       if (!user?.id) {
//         throw badRequest("Not authenticated.");
//       }
//
//       const { lines, notes } = parseRequestedLines(ctx.request.body);
//       const byId = await loadItemsByIds(lines.map((line) => line.item));
//       assertSufficientStock(lines, byId);
//
//       const stockLines: TransactionLine[] = lines.map((line) => {
//         const item = byId.get(line.item)!;
//         return { id: item.id, qtyPulled: line.qtyPulled, item };
//       });
//
//       const moved = await decrementStock(stockLines);
//
//       const transaction = await strapi.documents(TRANSACTIONS_API).create({
//         data: {
//           orderStatus: "Completed",
//           notes,
//           custodian: user.id,
//           items: lines.map(({ item, qtyPulled }) => ({ item, qtyPulled })),
//         },
//       });
//
//       await writeStockAuditLogs(user, moved, transaction.id as number);
//
//       await strapi.documents(AUDIT_LOG_API).create({
//         data: {
//           user: user.id,
//           action: "Transaction Issued",
//           category: "Transaction",
//           target: `#${transaction.id}`,
//           detail: `Issued by ${user.username}: ${lines
//             .map((line) => {
//               const item = byId.get(line.item) as InventoryItem | undefined;
//               return `${line.qtyPulled} x ${item?.name ?? `#${line.item}`}`;
//             })
//             .join(", ")}`,
//         },
//       });
//
//       const created = await loadTransaction(transaction.documentId);
//
//       return { data: created };
//     }),
//
//     /**
//      * Complete a Pending transaction: decrement stock atomically, then write
//      * audit logs. Requires the Administrator role (permission-gated).
//      */
//     complete: runAction(async (ctx: Context) => {
//       const documentId = ctx.params.documentId as string;
//
//       const transaction = await loadTransaction(documentId);
//
//       if (!transaction) {
//         throw badRequest("Transaction not found.");
//       }
//
//       if (transaction.orderStatus !== "Pending") {
//         throw badRequest("Only pending transactions can be completed.");
//       }
//
//       const items: TransactionLine[] = transaction.items ?? [];
//       if (items.length === 0) {
//         throw badRequest("Transaction has no items.");
//       }
//
//       for (const line of items) {
//         if (!line.item) {
//           throw badRequest(
//             `A line item no longer exists in inventory (was: #${line.id}).`,
//           );
//         }
//       }
//
//       const moved = await decrementStock(items);
//
//       const admin = ctx.state.user as
//         | { id: number; username: string }
//         | undefined;
//
//       await strapi.documents(TRANSACTIONS_API).update({
//         documentId: transaction.documentId,
//         data: { orderStatus: "Completed" },
//       });
//
//       if (admin?.id) {
//         await writeStockAuditLogs(admin, moved, transaction.id);
//
//         await strapi.documents(AUDIT_LOG_API).create({
//           data: {
//             user: admin.id,
//             action: "Transaction Completed",
//             category: "Transaction",
//             target: `#${transaction.id}`,
//             detail: summarize(items),
//           },
//         });
//       }
//
//       const updated = await loadTransaction(transaction.documentId);
//
//       return { data: updated };
//     }),
//
//     /**
//      * Void a Pending transaction without touching stock. Requires the
//      * Administrator role (permission-gated).
//      */
//     void: runAction(async (ctx: Context) => {
//       const documentId = ctx.params.documentId as string;
//
//       const transaction = await loadTransaction(documentId);
//
//       if (!transaction) {
//         throw badRequest("Transaction not found.");
//       }
//
//       if (transaction.orderStatus !== "Pending") {
//         throw badRequest("Only pending transactions can be voided.");
//       }
//
//       const admin = ctx.state.user as
//         | { id: number; username: string }
//         | undefined;
//
//       await strapi.documents(TRANSACTIONS_API).update({
//         documentId: transaction.documentId,
//         data: { orderStatus: "Voided" },
//       });
//
//       if (admin?.id) {
//         await strapi.documents(AUDIT_LOG_API).create({
//           data: {
//             user: admin.id,
//             action: "Transaction Voided",
//             category: "Transaction",
//             target: `#${transaction.id}`,
//             detail: summarize(transaction.items ?? []),
//           },
//         });
//       }
//
//       const updated = await loadTransaction(transaction.documentId);
//
//       return { data: updated };
//     }),
//   }),
// );
