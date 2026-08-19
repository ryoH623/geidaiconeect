// src/utils/reserveUrl.ts
// 予約フォーム（/reserve）へ渡すクエリの組み立て。
// トップページ（GeidaiConnectUi）と講師詳細ページ（TeacherDetail）で共用する。
import type { TeacherProfile, LessonCourse } from "../lib/teacherProfiles";

export function buildReserveUrl(teacher: TeacherProfile, course: LessonCourse): string {
  const params = new URLSearchParams({
    teacherId: teacher.authUid,
    teacher: teacher.name,
    course: course.title,
    // 料金は数値で持っているが、クエリ文字列なので文字列化して渡す
    price: String(course.price),
    lessonType: course.type,
  });

  if (course.locationDisplay) {
    params.set("locationDisplay", course.locationDisplay);
  }

  if (course.note) {
    params.set("note", course.note);
  }

  return `/reserve?${params.toString()}`;
}
