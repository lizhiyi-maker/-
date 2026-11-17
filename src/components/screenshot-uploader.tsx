"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";

type ItemState = "uploading" | "added" | "duplicate" | "failed";
interface Item {
  id: number;
  name: string;
  state: ItemState;
  error?: string;
  file: File;
}

const STATE_TEXT: Record<ItemState, string> = {
  uploading: "上传中…",
  added: "已添加",
  duplicate: "重复，已跳过",
  failed: "上传失败",
};

/** 逐张上传：每张独立成功或失败，失败的可单独重试；已上传的截图由服务端保存，刷新页面不会丢。 */
export function ScreenshotUploader({ batchId, remaining }: { batchId: string; remaining: number }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  const patch = (id: number, p: Partial<Item>) => setItems((all) => all.map((i) => (i.id === id ? { ...i, ...p } : i)));

  async function upload(item: Item) {
    patch(item.id, { state: "uploading", error: undefined });
    const fd = new FormData();
    fd.append("file", item.file);
    try {
      const res = await fetch(`/api/imports/${batchId}/screenshots`, { method: "POST", body: fd });
      const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
      if (res.ok) patch(item.id, { state: body.status === "duplicate" ? "duplicate" : "added" });
      else patch(item.id, { state: "failed", error: body.error ?? "上传失败，请重试" });
    } catch {
      patch(item.id, { state: "failed", error: "网络异常，请重试" });
    }
  }

  async function onPick(files: FileList | null) {
    if (!files || files.length === 0) return;
    setNotice(undefined);
    const picked = Array.from(files);
    if (picked.length > remaining) setNotice(`这一批最多还能再添加 ${remaining} 张，多出的 ${picked.length - remaining} 张没有上传。`);
    const accepted = picked.slice(0, Math.max(remaining, 0));
    const base = Date.now();
    const created: Item[] = accepted.map((file, i) => ({ id: base + i, name: file.name, state: "uploading", file }));
    setItems((all) => [...all, ...created]);
    setBusy(true);
    for (const item of created) await upload(item);
    setBusy(false);
    if (input.current) input.current.value = "";
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <input
        ref={input}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        id="screenshot-input"
        data-testid="screenshot-input"
        disabled={busy || remaining <= 0}
        onChange={(e) => void onPick(e.target.files)}
      />
      <label
        htmlFor="screenshot-input"
        className="flex h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed bg-card text-sm text-muted-foreground has-[:disabled]:opacity-50"
      >
        <ImagePlus className="size-6" aria-hidden />
        {remaining <= 0 ? "已达到单批上限" : busy ? "正在上传…" : "点击选择聊天截图（可多选）"}
      </label>
      <p className="text-xs text-muted-foreground">支持 PNG、JPEG、WebP，单张不超过 8 MB。上传后不会自动识别。</p>
      {notice && (
        <p role="status" className="rounded-md bg-warn/40 px-3 py-2 text-sm text-warn-foreground">
          {notice}
        </p>
      )}
      {items.length > 0 && (
        <ul className="space-y-1 text-sm" data-testid="upload-items">
          {items.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2">
              <span className="min-w-0 truncate">{i.name}</span>
              <span className={i.state === "failed" ? "shrink-0 text-red-700" : "shrink-0 text-muted-foreground"}>
                {i.error ?? STATE_TEXT[i.state]}
                {i.state === "failed" && (
                  <Button type="button" size="sm" variant="ghost" className="ml-1" onClick={() => void upload(i).then(() => router.refresh())}>
                    重试
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
