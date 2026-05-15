/**
 * Shared types for the InvoiceDiagnostics sub-components.
 */

export interface OrderSlim {
  _id: string;
  orderId: string;
  userEmail?: string;
  userName?: string;
  status: string;
  amount: number;
  invoiceNumber?: string;
  zohoInvoiceId?: string;
  razorpayPaymentId?: string;
  createdAt: string;
  isDeleted?: boolean;
}

export interface ConflictGroup {
  invoiceNumber: string;
  count: number;
  orders: OrderSlim[];
}

export interface DiagnosticsResponse {
  conflicts: ConflictGroup[];
  stuckOrders: OrderSlim[];
  summary: {
    conflictGroups: number;
    conflictedOrders: number;
    stuckOrders: number;
  };
}

export interface BulkProgress {
  total: number;
  done: number;
  success: number;
  failed: number;
}
