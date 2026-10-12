import { VannaLoader } from "@/components/v3/vanna-loader";

/**
 * Root route-transition fallback. Next wraps every page below `app/` in a Suspense boundary
 * with this as the fallback, so navigating between routes shows the branded Vanna loader
 * (inside the persistent navbar/layout) until the next page's server render streams in.
 */
export default function Loading() {
  return <VannaLoader size="page" label="Loading page" />;
}
