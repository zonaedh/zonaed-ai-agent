// /outreach — LinkedIn + cold outreach copy from a prospect page (plan §5.2)
import ToolRunner from "@/app/components/ToolRunner";

export default function OutreachPage() {
  return (
    <ToolRunner
      tool="outreach"
      title="Outreach generator"
      description="Generates LinkedIn connection note, InMail, cold email with subject line, and a follow-up, each opening with something specific from the prospect's page."
      urlLabel="Prospect profile or company URL"
      urlPlaceholder="https://linkedin.com/in/prospect or https://prospect-company.com"
      notesLabel="Your offer / angle (recommended)"
      notesPlaceholder="What you sell, the result you deliver, why this prospect..."
    />
  );
}
