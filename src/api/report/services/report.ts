/**
 * Sales report service.
 *
 * Aggregates completed SALE transactions for a date range. Price snapshots
 * stored on transactions and line items are used when available.
 *
 **/

import type { Core } from '@strapi/strapi'

const TRANSACTIONS_API = 'api::transaction.transaction'
const FETCH_PAGE_SIZE = 100
const MAX_EXPORT_ROWS = 5000

interface ItemRef {
    id: number
    name: string
    sku: string
}

interface LineRef {
    id: number
    qtyPulled: number | string | null
    unitPrice?: number | string | null
    lineTotal?: number | string | null
    item?: ItemRef | null
}

interface CashierRef {
    id: number
    username: string
}

interface SaleDoc {
    id: number
    documentId: string
    receiptNumber?: string | null
    purchaseDate?: string | null
    createdAt: string
    studentName?: string | null
    studentIdNumber?: string | null
    notes?: string | null
    total?: number | string | null
    items?: LineRef[]
    custodian?: CashierRef | null
}

interface DetailLine {
    itemId: number
    name: string
    sku: string
    qtyPulled: number
    unitPrice: number | null
    lineTotal: number | null
}

interface DetailRow {
    id: number
    documentId: string
    receiptNumber: string | null
    purchaseDate: string | null
    effectiveDate: string
    studentName: string | null
    studentIdNumber: string | null
    cashierId: number | null
    cashier: string
    notes: string | null
    total: number | null
    lines: DetailLine[]
}

interface CashierAccumulator {
    id: number | null
    username: string
    sales: number
    units: number
    revenue: number
    priced: number
}

export interface SalesReportParams {
    start: string
    end: string
    page: number
    pageSize: number
    search: string
    sort: string
    exportAll: boolean
}

function toNumber(value: unknown): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
}

function hasValue(value: unknown): boolean {
    return value !== null && value !== undefined && value !== ''
}

/** Prefer the transaction total, but fall back to fully-priced line items. */
function rowRevenue(row: DetailRow): number | null {
    if (row.total !== null) {
        return row.total
    }
    if (
        row.lines.length > 0 &&
        row.lines.every((line) => line.lineTotal !== null)
    ) {
        return row.lines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0)
    }
    return null
}

function compareText(a: string, b: string): number {
    return a.localeCompare(b)
}

const service = ({ strapi }: { strapi: Core.Strapi }) => ({
    async sales(params: SalesReportParams) {
        const { start, end } = params
        const startMs = Date.parse(start)
        const endMs = Date.parse(end)
        if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
            throw new Error('Invalid report date range.')
        }

        const documents: SaleDoc[] = []
        let page = 1

        while (true) {
            const batch = (await strapi.documents(TRANSACTIONS_API).findMany({
                filters: {
                    orderStatus: 'Completed',
                    $and: [
                        // Legacy sales were created before the `type` field
                        // existed, so a null type is still a sale here.
                        {
                            $or: [{ type: 'SALE' }, { type: { $null: true } }],
                        },
                        // Include either date field here and let the JS filter
                        // below decide using the effective date. Filtering
                        // `purchaseDate` with `''` would make Strapi try to
                        // parse it as a date and throw an invalid-format error.
                        {
                            $or: [
                                { purchaseDate: { $gte: start, $lte: end } },
                                { createdAt: { $gte: start, $lte: end } },
                            ],
                        },
                    ],
                },
                populate: {
                    items: { populate: { item: true } },
                    custodian: true,
                },
                sort: 'id:asc',
                pagination: { page, pageSize: FETCH_PAGE_SIZE },
            })) as SaleDoc[]

            documents.push(...batch)
            if (batch.length < FETCH_PAGE_SIZE) {
                break
            }
            page += 1
        }

        const rows: DetailRow[] = []
        for (const doc of documents) {
            const effective = hasValue(doc.purchaseDate)
                ? (doc.purchaseDate as string)
                : doc.createdAt
            const effectiveMs = Date.parse(effective)
            if (
                Number.isNaN(effectiveMs) ||
                effectiveMs < startMs ||
                effectiveMs > endMs
            ) {
                continue
            }

            const lines: DetailLine[] = (doc.items ?? []).map((line) => ({
                itemId: line.item?.id ?? line.id,
                name: line.item?.name ?? `Item #${line.item?.id ?? line.id}`,
                sku: line.item?.sku ?? '',
                qtyPulled: toNumber(line.qtyPulled),
                unitPrice: hasValue(line.unitPrice)
                    ? toNumber(line.unitPrice)
                    : null,
                lineTotal: hasValue(line.lineTotal)
                    ? toNumber(line.lineTotal)
                    : null,
            }))

            rows.push({
                id: doc.id,
                documentId: doc.documentId,
                receiptNumber: doc.receiptNumber ?? null,
                purchaseDate: doc.purchaseDate ?? null,
                effectiveDate: effective,
                studentName: doc.studentName ?? null,
                studentIdNumber: doc.studentIdNumber ?? null,
                cashierId: doc.custodian?.id ?? null,
                cashier: doc.custodian?.username ?? '—',
                notes: doc.notes ?? null,
                total: hasValue(doc.total) ? toNumber(doc.total) : null,
                lines,
            })
        }

        const students = new Set<string>()
        const cashiers = new Map<string, CashierAccumulator>()
        let units = 0
        let revenue = 0
        let pricedSales = 0

        for (const row of rows) {
            units += row.lines.reduce((sum, line) => sum + line.qtyPulled, 0)

            const saleRevenue = rowRevenue(row)
            if (saleRevenue !== null) {
                revenue += saleRevenue
                pricedSales += 1
            }

            const identity = row.studentIdNumber || row.studentName
            if (identity) {
                students.add(identity)
            }

            const cashier = cashiers.get(row.cashier) ?? {
                id: row.cashierId,
                username: row.cashier,
                sales: 0,
                units: 0,
                revenue: 0,
                priced: 0,
            }
            cashier.sales += 1
            cashier.units += row.lines.reduce(
                (sum, line) => sum + line.qtyPulled,
                0
            )
            if (saleRevenue !== null) {
                cashier.revenue += saleRevenue
                cashier.priced += 1
            }
            cashiers.set(row.cashier, cashier)
        }

        const searchTerm = params.search.trim().toLowerCase()
        let detail = searchTerm
            ? rows.filter((row) =>
                  [
                      row.receiptNumber ?? '',
                      row.studentName ?? '',
                      row.studentIdNumber ?? '',
                      row.cashier,
                      row.notes ?? '',
                  ]
                      .join(' ')
                      .toLowerCase()
                      .includes(searchTerm)
              )
            : [...rows]

        const [sortField, sortDirection] = params.sort.split(':')
        const desc = sortDirection === 'desc'
        const sortValue = (row: DetailRow): string | number => {
            switch (sortField) {
                case 'receipt':
                    return row.receiptNumber ?? ''
                case 'student':
                    return row.studentName ?? row.studentIdNumber ?? ''
                case 'cashier':
                    return row.cashier
                case 'total':
                    return row.total ?? -1
                default:
                    return Date.parse(row.effectiveDate) || 0
            }
        }
        detail.sort((a, b) => {
            const left = sortValue(a)
            const right = sortValue(b)
            const comparison =
                typeof left === 'number' && typeof right === 'number'
                    ? left - right
                    : compareText(String(left), String(right))
            return desc ? -comparison : comparison
        })

        const total = detail.length
        const pageSize = params.exportAll
            ? Math.min(total || 1, MAX_EXPORT_ROWS)
            : Math.min(Math.max(params.pageSize, 1), 100)
        const pageCount = params.exportAll
            ? 1
            : Math.max(1, Math.ceil(total / pageSize))
        const currentPage = params.exportAll
            ? 1
            : Math.min(Math.max(params.page, 1), pageCount)
        const startIndex = params.exportAll ? 0 : (currentPage - 1) * pageSize

        return {
            summary: {
                sales: rows.length,
                units,
                revenue: pricedSales > 0 ? revenue : null,
                averageSale: pricedSales > 0 ? revenue / pricedSales : null,
                pricedSales,
                students: students.size,
            },
            cashiers: [...cashiers.values()]
                .sort((a, b) => b.sales - a.sales || b.units - a.units)
                .map((cashier) => ({
                    id: cashier.id,
                    username: cashier.username,
                    sales: cashier.sales,
                    units: cashier.units,
                    revenue: cashier.priced > 0 ? cashier.revenue : null,
                })),
            detail: {
                rows: detail.slice(startIndex, startIndex + pageSize),
                meta: {
                    page: currentPage,
                    pageSize,
                    total,
                    pageCount,
                },
            },
        }
    },
})

export default service
