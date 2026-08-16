/**
 * transaction custom router
 */

export default {
  type: 'content-api' as const,
  routes: [
    {
      method: 'POST',
      path: '/transactions/request',
      handler: 'transaction.request',
    },
    {
      method: 'POST',
      path: '/transactions/issue',
      handler: 'transaction.issue',
    },
    {
      method: 'POST',
      path: '/transactions/:documentId/complete',
      handler: 'transaction.complete',
    },
    {
      method: 'POST',
      path: '/transactions/:documentId/void',
      handler: 'transaction.void',
    },
  ],
};
