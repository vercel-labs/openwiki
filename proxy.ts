import { NextRequest, NextResponse } from "next/server";
import { parseMarkdownRoute } from "@/app/lib/markdown-route";

export function proxy(request: NextRequest) {
  const markdownRoute = parseMarkdownRoute(request.nextUrl.pathname);
  if (markdownRoute === null) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/api/markdown";
  url.searchParams.set("owner", markdownRoute.owner);
  url.searchParams.set("repo", markdownRoute.repo);
  if (markdownRoute.slug !== undefined) {
    url.searchParams.set("slug", markdownRoute.slug);
  } else {
    url.searchParams.delete("slug");
  }

  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
