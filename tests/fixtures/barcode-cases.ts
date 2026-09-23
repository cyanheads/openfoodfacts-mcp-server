/**
 * @fileoverview Barcode inputs checked against Product Opener's `is_valid_code`
 * (`lib/ProductOpener/Products.pm`): strip leading zeros, then require 4–40 digits. Each accepted
 * code below was answered `status: 1` by `/api/v2/product/<code>.json` (2026-09-22), and each
 * rejected digit-only code was answered `status: 0`, "no code or invalid code". Shared by the
 * schema tests of every tool that takes a barcode, so the tools cannot drift apart.
 * @module tests/fixtures/barcode-cases
 */

/** Codes Open Food Facts serves, which a barcode input must accept. */
export const ACCEPTED_BARCODES = [
  '3017620422003', // EAN-13
  '6035215', // 7 digits, stored upstream as 06035215
  '1212', // 4 digits, stored upstream as 00001212
  '356470016977305', // 15 digits
  '5458913599654733609159', // 22 digits
  '00001212', // leading zeros, 4 significant digits
  '1'.repeat(40), // the 40-significant-digit ceiling
  `000${'1'.repeat(40)}`, // leading zeros do not count toward it
] as const;

/** Inputs a barcode input must reject before any request is sent. */
export const REJECTED_BARCODES = [
  '0123', // 3 significant digits
  '0000000000123', // 13 digits, 3 significant
  '00097', // 2 significant digits
  '0000', // no significant digit
  '123', // too short
  '1'.repeat(41), // 41 significant digits
  '3017620422003a', // upstream strips the letter and answers Nutella
  '3017-620422003',
  ' 3017620422003',
  '',
] as const;
