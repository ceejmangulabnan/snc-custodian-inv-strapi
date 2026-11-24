/**
 * report router
 */

export default {
    type: 'content-api' as const,
    routes: [
        {
            method: 'GET',
            path: '/reports/sales',
            handler: 'api::report.report.sales',
            config: {
                auth: {
                    scope: ['api::report.report.sales'],
                },
                policies: [],
            },
        },
    ],
}
