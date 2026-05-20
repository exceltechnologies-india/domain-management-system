/**
 * Shared axios instance for every Zoho Books API call.
 *
 * The plain `axios.get/post` we used to call doesn't carry a request
 * timeout, so a hung Zoho upstream stalled Cloud Run request slots until
 * the global request-timeout kicked in. Mirror the ResellerClub client's
 * 30s budget — any single Zoho call past that is almost certainly a
 * remote stall, not legitimate work-in-progress.
 *
 * Import as `zohoAxios` from this module and use it like the global
 * axios — `zohoAxios.get(...)`, `zohoAxios.post(...)`, etc.
 */
import axios from "axios";

export const zohoAxios = axios.create({
  timeout: 30_000,
});
