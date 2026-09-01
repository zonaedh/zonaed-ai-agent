// /competitor-spy — competitor landing page strategy analysis (plan §5.2)
import ToolRunner from "@/app/components/ToolRunner";

export default function CompetitorSpyPage() {
  return (
    <ToolRunner
      tool="competitor-spy"
      title="Competitor spy"
      description="Fetch a competitor's landing page and break down their positioning, pricing signals, proof tactics, and tone, then list exploitable gaps you can own."
      urlLabel="Competitor landing page URL"
      urlPlaceholder="https://competitor.com"
      notesLabel="Extra context (optional)"
      notesPlaceholder="Your product, the market, what you want to find out..."
    />
  );
}
