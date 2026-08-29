/** @type {import('next').NextConfig} */
const nextConfig = {
  // Cloudflare Pages 静态导出（同 metachina.ai 模式）
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
