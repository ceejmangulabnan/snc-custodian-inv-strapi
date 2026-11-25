/**
 * report controller
 */

import type { Context } from 'koa'
import type { Core } from '@strapi/strapi'
import type { SalesReportParams } from '../services/report'

function parsePositiveInt(value: unknown, fallback: number): number {
    const raw = Array.isArray(value) ? value[0] : value
    const parsed = Number.parseInt(String(raw), 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseText(value: unknown): string {
    const raw = Array.isArray(value) ? value[0] : value
    return typeof raw === 'string' ? raw : ''
}

const controller = ({ strapi }: { strapi: Core.Strapi }) => ({
    async sales(ctx: Context) {
        const query = ctx.query as Record<string, unknown>
        const start = parseText(query.start)
        const end = parseText(query.end)

        if (
            !start ||
            !end ||
            Number.isNaN(Date.parse(start)) ||
            Number.isNaN(Date.parse(end)) ||
            Date.parse(start) > Date.parse(end)
        ) {
            ctx.throw(400, 'A valid start and end date are required.')
        }

        // Always hand Strapi a full ISO string, even if a caller supplied a
        // looser date format that Date.parse() can still understand.
        const startIso = new Date(Date.parse(start)).toISOString()
        const endIso = new Date(Date.parse(end)).toISOString()

        const params: SalesReportParams = {
            start: startIso,
            end: endIso,
            page: parsePositiveInt(query.page, 1),
            pageSize: parsePositiveInt(query.pageSize, 10),
            search: parseText(query.search),
            sort: parseText(query.sort) || 'date:desc',
            exportAll: parseText(query.export) === '1',
        }

        return strapi.service('api::report.report').sales(params)
    },
})

export default controller
