// server/lib/oauth/metadata.mjs
//
// Pure builders for the two OAuth discovery documents: RFC 9728 protected-
// resource metadata and RFC 8414 authorization-server metadata (Gap-3 OAuth
// spec 4.1). baseUrl is UM_PUBLIC_BASE_URL — config-canonical, never derived
// from the Host header (spec 4.4). stripTrailingSlash() normalises the
// caller-supplied base so constructed URLs never double-slash.

const stripTrailingSlash = (u) => u.replace(/\/+$/, '');

export function protectedResourceMetadata(baseUrl) {
  const b = stripTrailingSlash(baseUrl);
  return {
    resource: `${b}/mcp`,
    authorization_servers: [b],
    scopes_supported: ['vault'],
    bearer_methods_supported: ['header'],
  };
}

export function authorizationServerMetadata(baseUrl) {
  const b = stripTrailingSlash(baseUrl);
  return {
    issuer: b,
    authorization_endpoint: `${b}/oauth/authorize`,
    token_endpoint: `${b}/oauth/token`,
    registration_endpoint: `${b}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    // #172 / RFC 9207: the iss parameter IS emitted on every authorization
    // response (endpoints.mjs, both the code and the access_denied redirects),
    // but the RFC 8414 ADVERTISEMENT (authorization_response_iss_parameter_
    // supported: true) is DELIBERATELY withheld: claude.ai's connector
    // validator (observed 2026-07-17, ua python-httpx, in the boostcamp-mcp
    // vendored deployment) aborts discovery on seeing the field — its AS
    // metadata differed from a working config by ONLY this line. Emitting
    // without advertising is conformant (the advert is a SHOULD). Re-add only
    // after verifying against a live claude.ai connector, and update the lock
    // test in oauth-iss-application-type.test.mjs with that evidence.
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    scopes_supported: ['vault', 'offline_access'],
  };
}
