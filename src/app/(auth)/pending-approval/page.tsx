"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Clock, LogOut, RefreshCw } from "lucide-react";

/**
 * Holding page for users whose status is 'pending' or 'disabled'.
 * Middleware bounces them here on every protected-route hit so they
 * can't poke around the app while waiting for an admin to approve
 * (or after being disabled).
 *
 * The page refreshes the session on mount — if an admin approves
 * mid-visit, the next "Try again" click sends them to the dashboard.
 */
export default function PendingApprovalPage() {
  const router = useRouter();
  const supabase = createClient();
  const [status, setStatus] = useState<"pending" | "disabled" | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.replace("/login");
      return;
    }
    const { data } = await supabase
      .from("profiles")
      .select("status")
      .eq("user_id", user.id)
      .maybeSingle();
    if (data?.status === "active") {
      router.replace("/dashboard");
      return;
    }
    setStatus((data?.status as "pending" | "disabled" | null) ?? "pending");
    setRefreshing(false);
  };

  useEffect(() => {
    refresh();
    // refresh is stable for the duration of this page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace("/login");
  };

  const isDisabled = status === "disabled";

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <Card className="w-full max-w-md border-slate-800 bg-slate-900">
        <CardHeader className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10 text-amber-300">
            <Clock className="h-6 w-6" />
          </div>
          <CardTitle className="text-white">
            {isDisabled ? "Account disabled" : "Waiting for approval"}
          </CardTitle>
          <CardDescription className="text-slate-400">
            {isDisabled
              ? "An administrator has disabled your account. Contact them to restore access."
              : "Your account is signed in but not yet approved. An administrator needs to grant you access before you can use the app."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!isDisabled && (
            <Button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              className="w-full"
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
              />
              Check again
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={handleSignOut}
            className="w-full border-slate-700 text-slate-200"
          >
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
