import type { NextConfig } from "next";

import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

export default (phase: string): NextConfig => {
  const isDev = phase === PHASE_DEVELOPMENT_SERVER;

  return {
    output: isDev ? undefined : "export",
    // @ts-expect-error NextConfig typing might be outdated for turbopack Next 16
    eslint: {
      ignoreDuringBuilds: true,
    },
    async rewrites() {
      if (isDev) {
        return [
          {
            source: '/api/:path*',
            destination: 'http://localhost:8005/api/:path*'
          }
        ];
      }
      return [];
    }
  };
};
