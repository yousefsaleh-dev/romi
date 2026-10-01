import { BookingsManager } from "@/components/bookings-manager";

export default function BookingsPage() {
  return (
    <div>
      <div className="page-head">
        <div><p className="eyebrow">إدارة الوصول</p><h1>الحجوزات</h1><p className="page-description">المستشفى تعمل ٢٤ ساعة؛ كل قسم له حجز واحد كل نصف ساعة، والأوقات تتولد تلقائيًا.</p></div>
      </div>
      <BookingsManager />
    </div>
  );
}
