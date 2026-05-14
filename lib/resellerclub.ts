/**
 * ResellerClub API Integration — backwards-compatible barrel.
 *
 * The implementation lives in focused submodules under `./resellerclub/`.
 * This file preserves the historic `ResellerClubAPI.<method>` surface so
 * existing call sites do not have to change.
 *
 * Submodules:
 * - ./resellerclub/client            shared axios instance + env validation
 * - ./resellerclub/search            pricing + domain search
 * - ./resellerclub/customers         customer + contact management
 * - ./resellerclub/registration      registration + domain lifecycle
 * - ./resellerclub/dns               DNS + nameservers
 * - ./resellerclub/renewal-transfer  renewal + transfer
 *
 * @author Anutech Digital Private Limited
 * @version 2.0.0
 * @since 2024
 */

import "./resellerclub/client"; // env validation + axios setup side effects
import * as search from "./resellerclub/search";
import * as customers from "./resellerclub/customers";
import * as registration from "./resellerclub/registration";
import * as dns from "./resellerclub/dns";
import * as renewalTransfer from "./resellerclub/renewal-transfer";

/**
 * ResellerClub Engine Core Architecture
 *
 * Static facade aggregating the topical submodules. All callable surface
 * (e.g. `ResellerClubAPI.searchDomain(...)`) is preserved verbatim for
 * backwards compatibility.
 *
 * Future developers should note that all methods remain strictly static
 * to prevent stateful initialization bugs across serverless requests.
 * Error handling is centralized in each submodule.
 */
export class ResellerClubAPI {
  // search — pricing + domain search
  static getDomainPricing = search.getDomainPricing;
  static getTLDPricing = search.getTLDPricing;
  static searchDomain = search.searchDomain;
  static searchDomainWithTlds = search.searchDomainWithTlds;
  static getResellerPricingForTLD = search.getResellerPricingForTLD;
  static getResellerDetails = search.getResellerDetails;

  // customers — customer + contact management (getCustomerId,
  // createCustomer, modifyCustomer, modifyContact, createContact,
  // getOrCreateCustomerAndContact appear here in source order; the
  // remaining customer methods — getCustomerDetails, getCustomerDomains —
  // are interleaved further down to preserve original ordering)
  static getCustomerId = customers.getCustomerId;
  static createCustomer = customers.createCustomer;
  static modifyCustomer = customers.modifyCustomer;
  static modifyContact = customers.modifyContact;
  static createContact = customers.createContact;
  static getOrCreateCustomerAndContact = customers.getOrCreateCustomerAndContact;

  // registration — registration + domain lifecycle
  static deleteDomainOrder = registration.deleteDomainOrder;
  static registerDomain = registration.registerDomain;
  static getDomainDetails = registration.getDomainDetails;

  // dns — DNS + nameservers
  static activateDNSManagement = dns.activateDNSManagement;
  static getDNSRecords = dns.getDNSRecords;
  static addDNSRecord = dns.addDNSRecord;
  static updateDNSRecord = dns.updateDNSRecord;
  static deleteDNSRecord = dns.deleteDNSRecord;
  static setDefaultNameservers = dns.setDefaultNameservers;
  static setCustomNameservers = dns.setCustomNameservers;

  // customers (continued, in original source position)
  static getCustomerDetails = customers.getCustomerDetails;

  // renewal-transfer — renewal + transfer
  static getRenewalPricing = renewalTransfer.getRenewalPricing;
  static renewDomain = renewalTransfer.renewDomain;

  // registration (continued, in original source position)
  static getDomainExpiry = registration.getDomainExpiry;

  // renewal-transfer (continued, in original source position)
  static transferDomain = renewalTransfer.transferDomain;

  // customers (continued, in original source position)
  static getCustomerDomains = customers.getCustomerDomains;

  // registration (continued, in original source position)
  static getDomainOrderId = registration.getDomainOrderId;

  // dns (continued, in original source position)
  static getNameservers = dns.getNameservers;
}
