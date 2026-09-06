/**
 * transaction custom router
 */

export default {
  type: "content-api" as const,
  routes: [
    {
      method: "POST",
      path: "/transactions/request",
      handler: "api::transaction.custom-transaction.request",
      config: {
        auth: { scope: ["api::transaction.custom-transaction.request"] },
        policies: [],
      },
    },
    {
      method: "POST",
      path: "/transactions/issue",
      handler: "api::transaction.custom-transaction.issue",
      config: {
        auth: { scope: ["api::transaction.custom-transaction.issue"] },
        policies: [],
      },
    },
    {
      method: "POST",
      path: "/transactions/:documentId/complete",
      handler: "api::transaction.custom-transaction.complete",
      config: {
        auth: { scope: ["api::transaction.custom-transaction.complete"] },
        policies: [],
      },
    },
    {
      method: "POST",
      path: "/transactions/:documentId/void",
      handler: "api::transaction.custom-transaction.void",
      config: {
        auth: { scope: ["api::transaction.custom-transaction.void"] },
        policies: [],
      },
    },
  ],
};
