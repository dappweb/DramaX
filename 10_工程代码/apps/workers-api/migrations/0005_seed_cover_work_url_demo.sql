-- 0005: Testnet 演示剧本补封面与作品地址（仅 dramax-testnet 库使用，勿在生产库执行）
-- 封面：picsum 稳定随机图（seed=script id）；作品地址：mobile /work?id= 作品详情页
-- 前置：0004_cover_work_url.sql 已应用
-- 注：work_url 现指向 /work?id=（静态导出查询参数方案，免 generateStaticParams）；
-- 域名用 testnet Pages（dramax-mobile-testnet），其构建 NEXT_PUBLIC_API_BASE 指向 testnet API

UPDATE scripts SET cover_url = 'https://picsum.photos/seed/' || id || '/300/300',
                   work_url  = 'https://dramax-mobile-testnet.pages.dev/work?id=' || id
WHERE id IN ('script-01', 'script-02', 'script-03', 'script-04', 'script-05', 'script-06');
