"use client";

// 剧本封面缩略图 + 作品跳转链接（市场列表 / 首页场次卡片共用）
// 封面：有 cover_url 用 <img>（静态导出场景比 next/image 稳），无图显示浅灰占位块 + 🎬
// 作品地址：work_url 非空时显示「作品 ↗」，新窗口打开（noopener）

export function ScriptCover({ coverUrl, title, size = 52 }: { coverUrl: string | null; title?: string | null; size?: number }) {
  if (coverUrl) {
    return (
      <img
        src={coverUrl}
        alt={title ?? "剧本封面"}
        width={size}
        height={size}
        loading="lazy"
        style={{ width: size, height: size, borderRadius: 10, objectFit: "cover", flexShrink: 0, background: "#f3f4f6" }}
      />
    );
  }
  // 无图占位：浅灰方块 + emoji（取标题首字更佳，但 emoji 统一风格更稳）
  return (
    <div
      aria-label={title ?? "剧本封面占位"}
      style={{
        width: size, height: size, borderRadius: 10, flexShrink: 0,
        background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.4,
      }}
    >
      🎬
    </div>
  );
}

export function WorkLink({ workUrl }: { workUrl: string | null }) {
  if (!workUrl) return null;
  return (
    <a
      className="work-link"
      href={workUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        window.open(workUrl, "_blank", "noopener");
      }}
    >
      作品 ↗
    </a>
  );
}
