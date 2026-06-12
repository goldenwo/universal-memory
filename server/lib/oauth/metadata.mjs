// server/lib/oauth/metadata.mjs
// Pure builders for the two discovery documents (spec 4.1).
// baseUrl is UM_PUBLIC_BASE_URL -- config-canonical, never Host-derived (spec 4.4).

const strip = (u) => u.replace(/\/+$/, '');

export function protectedResourceMetadata(baseUrl) {
  const b = strip(baseUrl);
  return {
    resource: `${b}/mcp`,
    authorization_servers: [b],
    scopes_supported: ['vault'],
    bearer_methods_supported: ['header'],
  };
}

export function authorizationServerMetadata(baseUrl) {
  const b = strip(baseUrl);
  return {
    issuer: b,
    authorization_endpoint: `${b}/oauth/authorize`,
    token_endpoint: `${b}/oauth/token`,
    registration_endpoint: `${b}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    scopes_supported: ['vault', 'offline_access'],
  };
}
