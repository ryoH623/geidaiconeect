// src/utils/tagIconMap.ts
import {
  faUserGraduate,
  faCarSide,
  faGift,
  faLaptop,
  faChild,
  faMedal,
  faUsers,
  faMusic,
  faTrophy,
  faPencil,
  faFolderOpen,
  faPalette,
} from "@fortawesome/free-solid-svg-icons";

// 講師カードに出す特徴タグとアイコンの対応。
//
// ここに無いタグを設定するとアイコンだけが出ず、見た目が揃わなくなる。
// タグを増やすときは TeacherProfileForm.tsx の TAG_OPTIONS も必ず一緒に直すこと。
export const tagIconMap: { [key: string]: any } = {
  // 共通
  "初心者歓迎": faUserGraduate,
  "出張可": faCarSide,
  "体験レッスンあり": faGift,
  "オンライン対応": faLaptop,
  "子ども対応": faChild,
  "受験対応": faMedal,

  // 音楽系
  "室内楽対応": faUsers,
  "伴奏あり": faMusic,
  "コンクール対応": faTrophy,

  // 美術系
  "デッサン指導": faPencil,
  "ポートフォリオ添削": faFolderOpen,
  "画材貸出あり": faPalette,
};
