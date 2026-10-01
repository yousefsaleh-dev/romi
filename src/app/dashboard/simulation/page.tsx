import { LiveSimulation } from "@/components/live-simulation";

export default function SimulationPage() {
  return (
    <div className="simulation-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">تجربة الاستقبال</p>
          <h1>محاكاة ROMI الصوتية</h1>
          <p className="page-description">اتكلم معاها كأنك عند بوابة المستشفى؛ الكلام بيتعرض لحظيًا وما بيتحفظش.</p>
        </div>
        <div className="simulation-page-tag"><span className="site-dot" /> تجربة افتراضية · لا تحرك الباب الحقيقي</div>
      </div>
      <LiveSimulation configured={Boolean(process.env.GEMINI_API_KEY)} />
    </div>
  );
}
