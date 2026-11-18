/** 圆形头像：取昵称第一个字，颜色由昵称稳定算出（同一个人永远同一种颜色）。装饰用，对读屏隐藏。 */
export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  const initial = Array.from(name.trim())[0] ?? "?";
  return (
    <span
      aria-hidden
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.46, ["--avatar-hue" as string]: h }}
    >
      {initial}
    </span>
  );
}
