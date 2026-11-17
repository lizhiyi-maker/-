"use client";

import { Button, type ButtonProps } from "@/components/ui/button";

/** 提交前弹出浏览器确认框；用于删除等不可恢复操作。 */
export function ConfirmButton({ message, children, ...props }: ButtonProps & { message: string }) {
  return (
    <Button
      type="submit"
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
      {...props}
    >
      {children}
    </Button>
  );
}
