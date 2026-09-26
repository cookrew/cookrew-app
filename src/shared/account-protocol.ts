/**
 * A 404 below /v1/accounts can mean either "this username is free" or "this
 * deployment predates accounts". The route marks every response so clients
 * can tell those two answers apart without a second request.
 */
export const ACCOUNT_ROUTE_VERSION_HEADER = 'x-cookrew-accounts-version'
export const ACCOUNT_ROUTE_VERSION = '1'
