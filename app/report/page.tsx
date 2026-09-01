// /report — website audit + client proposal (plan §5.2, §9 priority 9)
import ToolRunner from "@/app/components/ToolRunner";

export default function ReportPage() {
  return (
    <ToolRunner
      tool="report"
      title="Website audit + proposal"
      description="Audit a client's website and generate a client-facing proposal: offer clarity, trust signals, SEO basics, conversion paths, and content gaps."
      urlLabel="Client website URL"
      urlPlaceholder="https://client-website.com"
      notesLabel="Extra context (optional)"
      notesPlaceholder="What you're pitching, the client's goals, anything the site doesn't show..."
    />
  );
}
