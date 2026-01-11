"use client";

import { useSession } from "next-auth/react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect } from "react";
import { healthApi } from "@/lib/api";
import UserMenu from "./UserMenu";
import Taskbar from "./Taskbar";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const pathname = usePathname();
  
  // Hide shell on login page or when not authenticated
  const isLoginPage = pathname === "/login";
  const showShell = status === "authenticated" && !isLoginPage;

  // Warm up the backend connection on mount
  useEffect(() => {
    if (status === "authenticated") {
      healthApi.check().catch(() => {
        // Ignore errors, this is just a best-effort warmup
      });
    }
  }, [status]);

  if (!showShell) {
    return <>{children}</>;
  }

  return (
    <>
      <div className="min-h-screen pb-20">
        <header className="sticky top-0 z-10 border-b border-slate-800 bg-black/80 backdrop-blur">
          <div className="flex items-center justify-between px-6 py-4">
            <Link
              href="/"
              className="text-lg font-semibold tracking-tight text-white"
            >
              OMNES
            </Link>
            <UserMenu />
          </div>
        </header>
        <main className="px-6 py-12">{children}</main>
      </div>
      <Taskbar />
    </>
  );
}
