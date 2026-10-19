import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

export function invalidateForPath(path) {
  const resource = path.replace(/^\//, "").split("/")[0] || "all";
  queryClient.invalidateQueries({ queryKey: ["rota", "all"] });
  queryClient.invalidateQueries({ queryKey: ["rota", resource] });
  window.dispatchEvent(new CustomEvent("rota:data-changed", { detail: { path, resource } }));
}
