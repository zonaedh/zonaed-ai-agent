// /marketing-plan — homepage URL → subpage crawl → marketing plan (plan §5.2)
import ToolRunner from "@/app/components/ToolRunner";

export default function MarketingPlanPage() {
  return (
    <ToolRunner
      tool="marketing-plan"
      title="Marketing plan generator"
      description="Crawls the business website (homepage plus subpages) and builds a practical marketing plan: audience, positioning, channels, content strategy, and a 30/60/90-day order."
      urlLabel="Homepage URL"
      urlPlaceholder="https://business.com"
      notesLabel="Extra context (optional)"
      notesPlaceholder="Budget, market, what has or hasn't worked before..."
    />
  );
}
