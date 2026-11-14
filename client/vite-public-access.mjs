import {
  applyShareDocumentHeaders,
  applyTrustedForwardedHeaders,
  configureFrontendProxy,
  getAllowedFrontendHosts,
  isAllowedFrontendHost,
} from '../scripts/lib/frontend-access.mjs';

export { applyShareDocumentHeaders, applyTrustedForwardedHeaders };

export function createPublicAccessPlugin(config) {
  return {
    name: 'relay-public-access',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (isAllowedFrontendHost(req.headers.host, config)) {
          applyShareDocumentHeaders(req, res);
          return next();
        }
        res.statusCode = 403;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Relay 拒绝了未配置的访问地址');
      });
    },
  };
}

export function getAllowedHosts(config) {
  return getAllowedFrontendHosts(config);
}

export function configurePublicProxy(proxy, config) {
  configureFrontendProxy(proxy, config);
}
