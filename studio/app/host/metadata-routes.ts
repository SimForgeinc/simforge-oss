import type { MetadataRoute } from "next";

/**
 * `robots.txt` and `sitemap.xml` for this host (a slot: see host-slots.json).
 * A local installation is not a website: nothing is crawlable.
 */
export function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}

export function sitemap(): MetadataRoute.Sitemap {
  return [];
}
