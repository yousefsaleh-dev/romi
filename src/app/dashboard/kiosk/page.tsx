import { LiveSimulation } from "@/components/live-simulation";

export default function KioskPage() {
  return (
    <div className="simulation-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">تشغيل الاستقبال</p>
          <h1>استقبال مع ESP32</h1>
          <p className="page-description">صوت المتصفح مع الباب الفعلي. فتح الباب ينتظر تأكيد ESP32.</p>
        </div>
        <div className="simulation-page-tag"><span className="site-dot" /> أوامر فعلية للباب</div>
      </div>
      <LiveSimulation configured={Boolean(process.env.GEMINI_API_KEY)} mode="device" />
    </div>
  );
}
