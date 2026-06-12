import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { api, queryKeys } from "../lib/api";
import { authClient } from "../lib/auth-client";
import {
  type ThemePreference,
  getColorTheme,
  getThemePreference,
  setColorTheme,
  setThemePreference,
} from "../lib/theme";
import { colorThemes } from "../lib/tweakcn-themes";

export const Route = createFileRoute("/account")({ component: SettingsPage });

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

function SettingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: queryKeys.me(), queryFn: api.me });
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [colorTheme, setSelectedColorTheme] = useState("book-cook");

  useEffect(() => {
    setTheme(getThemePreference());
    setSelectedColorTheme(getColorTheme());
  }, []);

  return (
    <section className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="mb-6 text-3xl font-semibold">Settings</h1>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Display</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-2">
              {THEME_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  variant={theme === option.value ? "default" : "outline"}
                  className="h-20 flex-col"
                  onClick={() => {
                    setTheme(option.value);
                    setThemePreference(option.value);
                  }}
                >
                  <option.icon className="h-5 w-5" />
                  {option.label}
                </Button>
              ))}
            </div>
            <div className="mt-5 grid gap-2">
              <label htmlFor="color-theme" className="text-sm font-medium">
                Color theme
              </label>
              <Select
                value={colorTheme}
                onValueChange={(value) => {
                  setSelectedColorTheme(value);
                  setColorTheme(value);
                }}
              >
                <SelectTrigger id="color-theme" aria-label="Color theme">
                  <SelectValue placeholder="Choose a tweakcn theme" />
                </SelectTrigger>
                <SelectContent>
                  {colorThemes.map((item) => (
                    <SelectItem key={item.name} value={item.name}>
                      {item.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {colorThemes
                .filter((item) => item.name === colorTheme)
                .map((item) => (
                  <div
                    key={item.name}
                    className="grid gap-3 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-[auto_auto_1fr] sm:items-center"
                  >
                    <span
                      aria-hidden
                      className="h-5 w-5 rounded-full border"
                      style={{ backgroundColor: item.primaryLight }}
                    />
                    <span
                      aria-hidden
                      className="h-5 w-5 rounded-full border"
                      style={{ backgroundColor: item.primaryDark }}
                    />
                    <span className="min-w-0 truncate text-muted-foreground">{item.fontSans}</span>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
          </CardHeader>
          <CardContent>
            {me.data ? (
              <dl className="grid grid-cols-[120px_1fr] gap-y-3 text-sm">
                <dt className="text-muted-foreground">Email</dt>
                <dd>{me.data.user.email}</dd>
                <dt className="text-muted-foreground">Plan</dt>
                <dd>
                  <Badge>{me.data.user.plan}</Badge>
                </dd>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6">
        <Button
          variant="outline"
          onClick={() =>
            authClient.signOut().then(() => {
              queryClient.clear();
              // "/" is the signed-in hub home now; land on the marketing page.
              void navigate({ to: "/welcome", replace: true });
            })
          }
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </section>
  );
}
