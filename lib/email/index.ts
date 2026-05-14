import { sendEmail } from "./transporter";
import type { EmailOptions } from "./transporter";

import {
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendPasswordResetNotificationEmail,
  sendPasswordChangeNotificationEmail,
  sendProfileUpdateEmail,
  sendProfileCompletionEmail,
  sendActivationEmail,
} from "./auth";

import {
  sendPurchaseOrderEmail,
  sendOrderConfirmationEmail,
  sendAdminNotification,
  sendLowBalanceAlert,
} from "./billing";

import {
  sendDomainPurchaseEmail,
  sendDomainRegistrationEmail,
  sendDomainRegistrationFailureEmail,
  sendRenewalInvoiceEmail,
  sendDomainBookingStatusEmail,
  sendServiceReminderEmail,
  sendServiceExpiryTodayEmail,
  sendServiceSuspensionEmail,
  sendServiceGracePeriodEmail,
  sendDomainAvailableEmail,
} from "./domain";

import { sendHostingProvisionedEmail } from "./hosting";

export type { EmailOptions };
export { sendEmail };

export class EmailService {
  static sendEmail = sendEmail;

  static sendWelcomeEmail = sendWelcomeEmail;
  static sendPasswordResetEmail = sendPasswordResetEmail;
  static sendPasswordResetNotificationEmail = sendPasswordResetNotificationEmail;
  static sendPasswordChangeNotificationEmail = sendPasswordChangeNotificationEmail;
  static sendProfileUpdateEmail = sendProfileUpdateEmail;
  static sendProfileCompletionEmail = sendProfileCompletionEmail;
  static sendActivationEmail = sendActivationEmail;

  static sendPurchaseOrderEmail = sendPurchaseOrderEmail;
  static sendOrderConfirmationEmail = sendOrderConfirmationEmail;
  static sendAdminNotification = sendAdminNotification;
  static sendLowBalanceAlert = sendLowBalanceAlert;

  static sendDomainPurchaseEmail = sendDomainPurchaseEmail;
  static sendDomainRegistrationEmail = sendDomainRegistrationEmail;
  static sendDomainRegistrationFailureEmail = sendDomainRegistrationFailureEmail;
  static sendRenewalInvoiceEmail = sendRenewalInvoiceEmail;
  static sendDomainBookingStatusEmail = sendDomainBookingStatusEmail;
  static sendServiceReminderEmail = sendServiceReminderEmail;
  static sendServiceExpiryTodayEmail = sendServiceExpiryTodayEmail;
  static sendServiceSuspensionEmail = sendServiceSuspensionEmail;
  static sendServiceGracePeriodEmail = sendServiceGracePeriodEmail;
  static sendDomainAvailableEmail = sendDomainAvailableEmail;

  static sendHostingProvisionedEmail = sendHostingProvisionedEmail;
}
