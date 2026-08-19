// src/App.tsx
// ※ Router（BrowserRouter）は main.tsx で全体を包んでいるため、ここでは Routes/Route のみ使用します。
import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import Header from "./components/Header";
import ScrollToTop from "./components/ScrollToTop";
import GeidaiConnect from "./GeidaiConnectUi";
import Login from "./Login";
import Register from "./pages/Register";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import OperatorInfo from "./pages/OperatorInfo";
import Footer from "./components/Footer";
import ReviewSubmissionPage from "./pages/ReviewSubmissionPage";
import SearchResults from "./components/SearchResults";
import TeacherDetail from "./pages/TeacherDetail";
import Contact from "./pages/Contact";
import RequestPage from "./pages/RequestPage";
import TeacherRecruit from "./pages/TeacherRecruit";
import Terms from "./pages/Terms";
import LegalNotice from "./pages/LegalNotice";
import Faq from "./pages/Faq";
import RequireAdmin from "./components/RequireAdmin";
import RequireTeacher from "./components/RequireTeacher";
import PaymentSuccessPage from "./pages/PaymentSuccessPage";
import PaymentCancelPage from "./pages/PaymentCancelPage";
import VerifyEmailNotice from "./pages/VerifyEmailNotice";
import MyPage from "./pages/MyPage";
import Profile from "./pages/Profile";
import StudentReservations from "./pages/student/StudentReservations";
import ReferralPage from "./pages/student/ReferralPage";
import ProtectedRoute from "./ProtectedRoute";

// 予約フォームと講師・管理画面はバンドルが大きく、初期表示では不要なため遅延読み込みする
const ReservationForm = lazy(() => import("./pages/ReservationForm"));
const ScheduleForm = lazy(() => import("./pages/teachers/ScheduleForm"));
const ScheduleList = lazy(() => import("./pages/teachers/ScheduleList"));
const TeacherReservations = lazy(
  () => import("./pages/teachers/TeacherReservations")
);
const AdminHome = lazy(() => import("./pages/admin/AdminHome"));
const AdminDashboard = lazy(() => import("./pages/admin/AdminDashboard"));
const AdminCommissionSim = lazy(() => import("./pages/admin/AdminCommissionSim"));
const AdminStudents = lazy(() => import("./pages/admin/AdminStudents"));
const AdminTeachers = lazy(() => import("./pages/admin/AdminTeachers"));
const AdminTeacherDetail = lazy(() => import("./pages/admin/AdminTeacherDetail"));
const AdminReservations = lazy(() => import("./pages/admin/AdminReservations"));
const AdminUsers = lazy(() => import("./pages/admin/AdminUsers"));
const AdminReviews = lazy(() => import("./pages/admin/AdminReviews"));
const AdminCoupons = lazy(() => import("./pages/admin/AdminCoupons"));
const AdminReferrals = lazy(() => import("./pages/admin/AdminReferrals"));
const AdminUserCampaigns = lazy(
  () => import("./pages/admin/AdminUserCampaigns")
);
const AdminContacts = lazy(() => import("./pages/admin/AdminContacts"));
const AdminRequests = lazy(() => import("./pages/admin/AdminRequests"));
const AdminSearchLogs = lazy(() => import("./pages/admin/AdminSearchLogs"));
const AdminTeacherProfiles = lazy(
  () => import("./pages/admin/AdminTeacherProfiles")
);
const TestCheckoutPage = lazy(() => import("./pages/TestCheckoutPage"));

function App() {
  return (
    <div className="app-container">
      <ScrollToTop />
      <Header />

      <div className="main-content">
        <Suspense fallback={<div style={{ padding: "2rem", textAlign: "center" }}>読み込み中...</div>}>
        <Routes>
          {/* 公開ルート */}
          <Route path="/" element={<GeidaiConnect />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/about" element={<OperatorInfo />} />
          <Route path="/privacy" element={<PrivacyPolicy />} />
          <Route path="/mypage/review" element={<ReviewSubmissionPage />} />
          <Route path="/search" element={<SearchResults />} />
          <Route path="/teachers/:id" element={<TeacherDetail />} />
          <Route path="/contact" element={<Contact />} />
          {/* 演奏・展示などの依頼フォーム（公開） */}
          <Route path="/request" element={<RequestPage />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/legal" element={<LegalNotice />} />
          {/* 講師募集ページ（未ログインの応募者向け・公開） */}
          <Route path="/recruit" element={<TeacherRecruit />} />

          {/* 予約フォーム
              既存の /reserve を残しつつ、
              Stripe の cancel_url などで使う /reservation も受けられるようにする */}
          <Route path="/reserve" element={<ReservationForm />} />
          <Route path="/reservation" element={<ReservationForm />} />

          <Route path="/faq" element={<Faq />} />
          <Route path="/test-checkout" element={<TestCheckoutPage />} />
          <Route path="/payment/success" element={<PaymentSuccessPage />} />
          <Route path="/payment/cancel" element={<PaymentCancelPage />} />

          {/* 会員登録後のメール確認案内 */}
          <Route path="/verify-email" element={<VerifyEmailNotice />} />

          {/* 🔐 ログイン必須ルート */}
          <Route
            path="/mypage"
            element={
              <ProtectedRoute>
                <MyPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/history"
            element={
              <ProtectedRoute>
                <StudentReservations />
              </ProtectedRoute>
            }
          />
          <Route
            path="/profile"
            element={
              <ProtectedRoute>
                <Profile />
              </ProtectedRoute>
            }
          />
          {/* 友達紹介（紹介コードの確認・実績・獲得クーポン） */}
          <Route
            path="/referral"
            element={
              <ProtectedRoute>
                <ReferralPage />
              </ProtectedRoute>
            }
          />

          {/* 🔐 講師専用ルート（ガード付き） */}
          <Route
            path="/schedule-form"
            element={
              <RequireTeacher>
                <ScheduleForm />
              </RequireTeacher>
            }
          />
          <Route
            path="/schedule-list"
            element={
              <RequireTeacher>
                <ScheduleList />
              </RequireTeacher>
            }
          />
          <Route
            path="/teacher/reservations"
            element={
              <RequireTeacher>
                <TeacherReservations />
              </RequireTeacher>
            }
          />

          {/* 🔐 管理者専用ルート（ガード付き） */}
          <Route
            path="/admin"
            element={
              <RequireAdmin>
                <AdminHome />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/teacher-profiles"
            element={
              <RequireAdmin>
                <AdminTeacherProfiles />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/search-logs"
            element={
              <RequireAdmin>
                <AdminSearchLogs />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/dashboard"
            element={
              <RequireAdmin>
                <AdminDashboard />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/commission-sim"
            element={
              <RequireAdmin>
                <AdminCommissionSim />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/students"
            element={
              <RequireAdmin>
                <AdminStudents />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/teachers"
            element={
              <RequireAdmin>
                <AdminTeachers />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/teachers/:id"
            element={
              <RequireAdmin>
                <AdminTeacherDetail />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/reservations"
            element={
              <RequireAdmin>
                <AdminReservations />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/users"
            element={
              <RequireAdmin>
                <AdminUsers />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/reviews"
            element={
              <RequireAdmin>
                <AdminReviews />
              </RequireAdmin>
            }
          />
          {/* キャンペーン（クーポン・友達紹介）の管理 */}
          <Route
            path="/admin/coupons"
            element={
              <RequireAdmin>
                <AdminCoupons />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/referrals"
            element={
              <RequireAdmin>
                <AdminReferrals />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/users/:uid/campaigns"
            element={
              <RequireAdmin>
                <AdminUserCampaigns />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/contacts"
            element={
              <RequireAdmin>
                <AdminContacts />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/requests"
            element={
              <RequireAdmin>
                <AdminRequests />
              </RequireAdmin>
            }
          />
        </Routes>
        </Suspense>
      </div>

      <Footer />
    </div>
  );
}

export default App;