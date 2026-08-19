import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { getAuth } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { doc, getDoc } from 'firebase/firestore';
import BookingCalendar from '../components/booking/BookingCalendar';
import { teachers, getCourses } from '../data/teachers';
import { prefectures } from '../data/prefectures';
import { citiesByPrefecture } from '../data/citiesByPrefecture';
import type { AvailableStudio } from '../data/studios';
import { usePrefectureCities, useTownsWithCoords } from '../hooks/useJapaneseAddresses';
import { useStationSearch, type StationHit } from '../hooks/useStationSearch';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { useMyCoupons } from '../hooks/useMyCoupons';
import {
  formatCouponExpiry,
  judgeCouponUsable,
  sortCouponsForPicker,
} from '../lib/coupons';
import '../index.css';

type FormDataType = {
  name: string;
  furigana: string;
  email: string;
  phone: string;
  location: string;
  notes: string;
};

type TeacherInfo = {
  authUid: string;
  name: string;
  email?: string;
};

type CreateReservationAndCheckoutPayload = {
  teacherId: string;
  teacherName: string;
  teacherEmail?: string;
  lessonCourse: string;
  lessonAmount: number;
  date: string;
  time: string;
  name: string;
  furigana: string;
  email: string;
  phone: string;
  location: string;
  notes?: string;
  paymentMethod?: 'card';
  lessonType?: string;
  durationMin?: number;
  studioId?: string;
  studioName?: string;
  studioFee?: number;
  // 値引き額はサーバー側で再計算されるため、クーポンのIDだけを送る
  couponId?: string;
};

type GetAvailableStudiosResult = {
  ok: boolean;
  studios: AvailableStudio[];
};

type CreateReservationAndCheckoutResult = {
  ok: boolean;
  reservationId: string;
  sessionId: string;
  url: string | null;
};

const ReservationForm: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const auth = getAuth();
  const { user: authUser } = useAuth();

  const queryParams = new URLSearchParams(location.search);
  const teacherIdFromQuery = decodeURIComponent(queryParams.get('teacherId') || '');
  const teacherNameFromQuery = decodeURIComponent(queryParams.get('teacher') || '');
  const lessonCourse = decodeURIComponent(queryParams.get('course') || '');
  const priceFromQuery = decodeURIComponent(queryParams.get('price') || '');
  const lessonTypeFromQuery = decodeURIComponent(queryParams.get('lessonType') || '');
  const locationDisplayFromQuery = decodeURIComponent(
    queryParams.get('locationDisplay') || ''
  );
  const noteFromQuery = decodeURIComponent(queryParams.get('note') || '');

  const [teacherInfo, setTeacherInfo] = useState<TeacherInfo | null>(null);
  const [teacherLoading, setTeacherLoading] = useState(true);

  const [displayMonth, setDisplayMonth] = useState<Date>(new Date());
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedTime, setSelectedTime] = useState('');

  const [formData, setFormData] = useState<FormDataType>({
    name: '',
    furigana: '',
    email: '',
    phone: '',
    location: '',
    notes: '',
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  // 確認画面は React state ではなく履歴エントリで表現する。
  // こうしないとブラウザの戻るで /reserve ごと離脱してしまう。
  const confirming =
    (location.state as { confirming?: boolean } | null)?.confirming === true;
  const [submitting, setSubmitting] = useState(false);
  // 支払い方法はクレジットカードのみ。予約時は与信のみで、請求はレッスン前日に確定する。
  const paymentMethod = 'card' as const;

  // ご予約者情報は会員情報（users/{uid}）から自動取得する。
  // 未ログイン→予約不可、プロフィール未完（氏名/フリガナ/メール/電話が欠け）→/profileへ誘導。
  const [profileChecked, setProfileChecked] = useState(false);
  const [missingProfileFields, setMissingProfileFields] = useState<string[]>([]);

  // スタジオ予約フロー用の state
  // 基準地点の指定方法。住所（都道府県→市区町村→町名）か、最寄り駅かを選ぶ。
  const [studioSearchMode, setStudioSearchMode] = useState<'address' | 'station'>(
    'address'
  );
  const [regionPref, setRegionPref] = useState('');
  const [regionCity, setRegionCity] = useState('');
  const [regionTown, setRegionTown] = useState('');
  // 基準地点からの検索半径(km)。市区町村の完全一致ではなく距離で絞り込む。
  const [searchRadiusKm, setSearchRadiusKm] = useState(5);
  const [stationKeyword, setStationKeyword] = useState('');
  const [selectedStation, setSelectedStation] = useState<StationHit | null>(null);
  const [studioSearching, setStudioSearching] = useState(false);
  const [studioResults, setStudioResults] = useState<AvailableStudio[]>([]);
  const [selectedStudio, setSelectedStudio] = useState<AvailableStudio | null>(null);
  const [studioSearchError, setStudioSearchError] = useState('');

  // ── 入力内容の下書き（ブラウザバック対策）─────────────────────────
  // 講師詳細へ戻ってから再度この画面に来ても入力し直さずに済むよう、
  // ユーザーが自分で選んだ項目だけを sessionStorage に保持する（タブを閉じれば消える）。
  // 氏名・フリガナ・メール・電話は会員情報から毎回自動反映されるため保存しない。
  const draftKey = `reserveDraft:${teacherIdFromQuery}:${lessonCourse}`;
  const [draftRestored, setDraftRestored] = useState(false);

  useEffect(() => {

    try {
      const raw = sessionStorage.getItem(draftKey);
      if (!raw) return;

      const draft = JSON.parse(raw) as Record<string, unknown>;
      console.log('予約フォームの下書きを復元します:', draft);

      if (typeof draft.selectedDate === 'string') setSelectedDate(draft.selectedDate);
      if (typeof draft.selectedTime === 'string') setSelectedTime(draft.selectedTime);
      if (typeof draft.location === 'string' || typeof draft.notes === 'string') {
        setFormData((prev) => ({
          ...prev,
          location: typeof draft.location === 'string' ? draft.location : prev.location,
          notes: typeof draft.notes === 'string' ? draft.notes : prev.notes,
        }));
      }
      // 選択日が別の月なら、その月をカレンダーに表示する
      if (typeof draft.selectedDate === 'string' && draft.selectedDate) {
        const [y, m] = draft.selectedDate.split('-').map(Number);
        if (y && m) setDisplayMonth(new Date(y, m - 1, 1));
      }
    } catch (error) {
      console.warn('下書きの復元に失敗しました:', error);
    } finally {
      setDraftRestored(true);
    }
  }, [draftKey]);

  useEffect(() => {
    // ref ではなく state で判定する。ref だと復元と同じ effect フラッシュ内で true になり、
    // 直後の保存が「復元前の空の値」で下書きを潰してしまう。
    if (!draftRestored) return;

    // 何も選ばれていない状態で既存の下書きを空にしない
    if (!selectedDate && !selectedTime && !formData.location && !formData.notes) return;

    try {
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({
          selectedDate,
          selectedTime,
          location: formData.location,
          notes: formData.notes,
        })
      );
    } catch (error) {
      console.warn('下書きの保存に失敗しました:', error);
    }
  }, [
    draftKey,
    draftRestored,
    selectedDate,
    selectedTime,
    formData.location,
    formData.notes,
  ]);

  useEffect(() => {
    console.log('================ ReservationForm 初期表示ログ ================');
    console.log('現在のURL:', location.pathname + location.search);
    console.log('URL teacherId:', teacherIdFromQuery);
    console.log('URL teacher:', teacherNameFromQuery);
    console.log('URL course:', lessonCourse);
    console.log('URL price:', priceFromQuery);
    console.log('URL lessonType:', lessonTypeFromQuery);
    console.log('URL locationDisplay:', locationDisplayFromQuery);
    console.log('URL note:', noteFromQuery);
    console.log('現在のログインユーザー:', auth.currentUser);
    console.log('============================================================');
  }, [
    location.pathname,
    location.search,
    teacherIdFromQuery,
    teacherNameFromQuery,
    lessonCourse,
    priceFromQuery,
    lessonTypeFromQuery,
    locationDisplayFromQuery,
    noteFromQuery,
    auth,
  ]);

  useEffect(() => {
    try {
      setTeacherLoading(true);

      console.log('================ 講師情報検索ログ ================');
      console.log('検索に使う teacherIdFromQuery:', teacherIdFromQuery);
      console.log('検索に使う teacherNameFromQuery:', teacherNameFromQuery);
      console.log('teachers 件数:', teachers.length);
      console.log(
        'teachers の authUid 一覧:',
        teachers.map((t) => ({
          name: t.name,
          authUid: t.authUid,
        }))
      );

      let foundTeacher = null;

      if (teacherIdFromQuery) {
        foundTeacher = teachers.find((t) => t.authUid === teacherIdFromQuery) || null;
        console.log('teacherId で検索した結果:', foundTeacher);
      }

      if (!foundTeacher && teacherNameFromQuery) {
        foundTeacher = teachers.find((t) => t.name === teacherNameFromQuery) || null;
        console.log('teacher 名で検索した結果:', foundTeacher);
      }

      if (!foundTeacher) {
        console.warn('講師情報が見つかりませんでした。');
        setTeacherInfo(null);
        return;
      }

      const nextTeacherInfo = {
        authUid: foundTeacher.authUid,
        name: foundTeacher.name,
        email: '',
      };

      console.log('ReservationForm にセットする teacherInfo:', nextTeacherInfo);
      console.log('BookingCalendar に渡す teacherId:', nextTeacherInfo.authUid);
      console.log('=================================================');

      setTeacherInfo(nextTeacherInfo);
    } catch (error) {
      console.error('講師情報の取得に失敗しました:', error);
      setTeacherInfo(null);
    } finally {
      setTeacherLoading(false);
    }
  }, [teacherIdFromQuery, teacherNameFromQuery]);

  const selectedTeacherCourse = useMemo(() => {
    let foundTeacher = null;

    if (teacherIdFromQuery) {
      foundTeacher = teachers.find((t) => t.authUid === teacherIdFromQuery) || null;
    }
    if (!foundTeacher && teacherNameFromQuery) {
      foundTeacher = teachers.find((t) => t.name === teacherNameFromQuery) || null;
    }

    if (!foundTeacher) {
      console.warn('selectedTeacherCourse: 講師が見つからないためコース取得不可');
      return null;
    }

    const teacherCourses = getCourses(foundTeacher);
    const foundCourse = teacherCourses.find((c) => c.title === lessonCourse) || null;

    console.log('================ コース検索ログ ================');
    console.log('対象講師:', foundTeacher.name);
    console.log('URL lessonCourse:', lessonCourse);
    console.log('講師の courses:', teacherCourses);
    console.log('一致した selectedTeacherCourse:', foundCourse);
    console.log('===============================================');

    return foundCourse;
  }, [teacherIdFromQuery, teacherNameFromQuery, lessonCourse]);

  const lessonAmount = useMemo(() => {
    const priceSource = priceFromQuery || selectedTeacherCourse?.price || lessonCourse;
    const normalized = priceSource.replace(/,/g, '');
    const match = normalized.match(/(\d{3,6})\s*円?/);
    const amount = match ? Number(match[1]) : null;

    console.log('================ 料金判定ログ ================');
    console.log('priceFromQuery:', priceFromQuery);
    console.log('selectedTeacherCourse?.price:', selectedTeacherCourse?.price);
    console.log('lessonCourse:', lessonCourse);
    console.log('priceSource:', priceSource);
    console.log('判定された lessonAmount:', amount);
    console.log('=============================================');

    return amount;
  }, [priceFromQuery, selectedTeacherCourse, lessonCourse]);

  const displayLessonType = useMemo(() => {
    const value = lessonTypeFromQuery || selectedTeacherCourse?.type || '';

    console.log('displayLessonType:', value);

    return value;
  }, [lessonTypeFromQuery, selectedTeacherCourse]);

  // レッスン所要時間(分)。コース名（例:「出張レッスン（60分）」）から推定。既定60分。
  const lessonDurationMin = useMemo(() => {
    const source = lessonCourse || selectedTeacherCourse?.title || '';
    const m = source.match(/(\d+)\s*分/);
    const v = m ? Number(m[1]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : 60;
  }, [lessonCourse, selectedTeacherCourse]);

  const displayLocationHint = useMemo(() => {
    const value = locationDisplayFromQuery || selectedTeacherCourse?.locationDisplay || '';

    console.log('displayLocationHint:', value);

    return value;
  }, [locationDisplayFromQuery, selectedTeacherCourse]);

  const displayCourseNote = useMemo(() => {
    const value = noteFromQuery || selectedTeacherCourse?.note || '';

    console.log('displayCourseNote:', value);

    return value;
  }, [noteFromQuery, selectedTeacherCourse]);

  // スタジオ予約フローか（レッスン種別が「スタジオ」）
  const isStudioFlow = displayLessonType === 'スタジオ';
  // オンライン予約フローか。会場がないためレッスン場所は「オンライン」で固定する。
  const isOnlineFlow = displayLessonType === 'オンライン';

  // 市区町村候補は Geolonia 住所マスタ（全市区町村を網羅）から取得。
  // マスタ取得失敗時は静的リスト（citiesByPrefecture）にフォールバック
  const { data: prefCityMap } = usePrefectureCities();
  const regionCityOptions = useMemo(() => {
    if (!regionPref) return [] as string[];
    const fromGeolonia = prefCityMap?.[regionPref];
    if (fromGeolonia && fromGeolonia.length > 0) return fromGeolonia;
    const pref = prefectures.find((p) => p.name === regionPref);
    if (!pref) return [] as string[];
    return citiesByPrefecture[pref.code] || [];
  }, [regionPref, prefCityMap]);

  // 町名候補（座標つき）。町名を選ぶとその代表座標が基準地点になる
  const {
    towns: regionTownOptions,
    loading: regionTownsLoading,
    error: regionTownsError,
  } = useTownsWithCoords(regionPref, regionCity);

  const {
    stations: stationOptions,
    loading: stationLoading,
    error: stationError,
    search: runStationSearch,
    reset: resetStationSearch,
  } = useStationSearch();

  // 距離検索の基準地点。駅 > 町名 > 市区町村の中心（町名の代表座標の平均）の順に使う。
  // いずれも決まらない場合は null（＝距離では絞り込めず、地域指定での検索になる）。
  const searchCenter = useMemo<{ lat: number; lng: number } | null>(() => {
    if (studioSearchMode === 'station') {
      return selectedStation
        ? { lat: selectedStation.lat, lng: selectedStation.lng }
        : null;
    }

    const town = regionTownOptions.find((t) => t.name === regionTown);
    if (town && typeof town.lat === 'number' && typeof town.lng === 'number') {
      return { lat: town.lat, lng: town.lng };
    }

    // 町名未選択でも、市区町村を選んでいればその中心を基準にできる
    const withCoords = regionTownOptions.filter(
      (t) => typeof t.lat === 'number' && typeof t.lng === 'number'
    );
    if (regionCity && withCoords.length > 0) {
      const lat =
        withCoords.reduce((sum, t) => sum + (t.lat as number), 0) / withCoords.length;
      const lng =
        withCoords.reduce((sum, t) => sum + (t.lng as number), 0) / withCoords.length;
      return { lat, lng };
    }

    return null;
  }, [studioSearchMode, selectedStation, regionTown, regionCity, regionTownOptions]);

  // 小計（レッスン料 + スタジオ代）。クーポン値引き前の金額。
  const subtotalAmount = useMemo(() => {
    const base = lessonAmount ?? 0;
    const studio = isStudioFlow && selectedStudio ? selectedStudio.pricePerSlot : 0;
    return base + studio;
  }, [lessonAmount, isStudioFlow, selectedStudio]);

  // ── クーポン ─────────────────────────────────────────────
  // コードの手入力ではなく、付与済みクーポンの一覧から選ばせる方式。
  // ここでの値引き表示はあくまで目安で、実際の決済金額は Cloud Functions が
  // 予約作成時に再計算する（フロントの金額は一切信用しない）。
  const { coupons: myCoupons } = useMyCoupons();
  const [selectedCouponId, setSelectedCouponId] = useState('');

  const couponOptions = useMemo(
    () => sortCouponsForPicker(myCoupons, subtotalAmount),
    [myCoupons, subtotalAmount]
  );

  const selectedCoupon = useMemo(
    () => myCoupons.find((c) => c.id === selectedCouponId) ?? null,
    [myCoupons, selectedCouponId]
  );

  const couponDiscount = useMemo(() => {
    if (!selectedCoupon) return 0;
    return judgeCouponUsable(selectedCoupon, subtotalAmount).usable
      ? selectedCoupon.discountAmount
      : 0;
  }, [selectedCoupon, subtotalAmount]);

  // 実際に決済される金額。0円以下にはならない。
  const payableAmount = Math.max(subtotalAmount - couponDiscount, 0);

  // スタジオを変えて最低利用金額を割った場合など、選択したクーポンが
  // 使えなくなったら選択を外す（使えないまま送信されるのを防ぐ）。
  useEffect(() => {
    if (!selectedCoupon) return;
    if (!judgeCouponUsable(selectedCoupon, subtotalAmount).usable) {
      setSelectedCouponId('');
    }
  }, [selectedCoupon, subtotalAmount]);

  // 会員情報（users/{uid}）からご予約者情報（氏名・フリガナ・メール・電話）と
  // 地域の初期値を取得する。予約フォームでは再入力させず、これらを自動で使う。
  useEffect(() => {
    if (!authUser) return;

    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'users', authUser.uid));
        if (cancelled) return;

        const d = snap.exists() ? snap.data() ?? {} : {};
        const name = `${d.lastName ?? ''}${d.firstName ?? ''}`.trim();
        const furigana = `${d.lastNameKana ?? ''}${d.firstNameKana ?? ''}`.trim();
        const email =
          typeof d.email === 'string' && d.email ? d.email : authUser.email || '';
        const phone =
          typeof d.phone === 'string' ? d.phone.replace(/[^\d]/g, '') : '';

        setFormData((prev) => ({ ...prev, name, furigana, email, phone }));

        const pref = d.prefecture;
        if (typeof pref === 'string' && pref) {
          setRegionPref((prev) => prev || pref);
        }

        // プロフィール未完のチェック（欠けている項目名を控える）
        const missing: string[] = [];
        if (!name) missing.push('お名前');
        if (!furigana) missing.push('フリガナ');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) missing.push('メールアドレス');
        if (!/^\d{10,11}$/.test(phone)) missing.push('電話番号');
        setMissingProfileFields(missing);
      } catch (error) {
        console.warn('会員情報の取得に失敗:', error);
      } finally {
        if (!cancelled) setProfileChecked(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authUser]);

  // オンラインは会場がないため、レッスン場所を「オンライン」で固定する
  useEffect(() => {
    if (!isOnlineFlow) return;
    setFormData((prev) =>
      prev.location === 'オンライン' ? prev : { ...prev, location: 'オンライン' }
    );
  }, [isOnlineFlow]);

  useEffect(() => {
    if (isOnlineFlow) return;
    setFormData((prev) => {
      if (prev.location.trim()) return prev;
      if (!displayLocationHint) return prev;

      console.log('レッスン場所に初期値をセット:', displayLocationHint);

      return {
        ...prev,
        location: displayLocationHint,
      };
    });
  }, [displayLocationHint, isOnlineFlow]);

  useEffect(() => {
    setFormData((prev) => {
      if (prev.notes.trim()) return prev;

      const autoNotes: string[] = [];
      if (displayLessonType) autoNotes.push(`レッスン種別: ${displayLessonType}`);
      if (displayCourseNote) autoNotes.push(`備考: ${displayCourseNote}`);

      if (autoNotes.length === 0) return prev;

      console.log('ご要望欄に初期メモをセット:', autoNotes);

      return {
        ...prev,
        notes: autoNotes.join('\n'),
      };
    });
  }, [displayLessonType, displayCourseNote]);

  useEffect(() => {
    console.log('================ 選択日時 state 更新ログ ================');
    console.log('selectedDate:', selectedDate);
    console.log('selectedTime:', selectedTime);
    console.log('=======================================================');
  }, [selectedDate, selectedTime]);

  const normalizeInput = (value: string): string => {
    return value.replace(/[\s　]/g, '');
  };

  const handleDateTimeSelect = (date: string, time: string) => {
    console.log('================ BookingCalendar から選択値受信 ================');
    console.log('受け取った date:', date);
    console.log('受け取った time:', time);
    console.log('現在の teacherInfo:', teacherInfo);
    console.log('現在の displayMonth:', displayMonth);
    console.log('==============================================================');

    setSelectedDate(date);
    setSelectedTime(time);

    // 日時が変わると空き状況も変わるため、スタジオ検索結果はリセット
    setStudioResults([]);
    setSelectedStudio(null);
    setStudioSearchError('');

    setErrors((prev) => ({
      ...prev,
      selectedDate: '',
      selectedTime: '',
    }));
  };

  const handleSearchStudios = async () => {
    if (!teacherInfo?.authUid) {
      setStudioSearchError('講師情報の取得に失敗しました。');
      return;
    }
    if (!selectedDate || !selectedTime) {
      setStudioSearchError('先にカレンダーからレッスン日時を選択してください。');
      return;
    }
    if (studioSearchMode === 'station') {
      if (!selectedStation) {
        setStudioSearchError('最寄り駅を検索して選択してください。');
        return;
      }
    } else if (!regionPref) {
      setStudioSearchError('地域（都道府県）を選択してください。');
      return;
    }

    setStudioSearching(true);
    setStudioSearchError('');
    setStudioResults([]);
    setSelectedStudio(null);

    try {
      const functions = getFunctions(undefined, 'us-central1');
      const getAvailableStudios = httpsCallable<
        {
          teacherId: string;
          date: string;
          time: string;
          prefecture?: string;
          city?: string;
          studentLat?: number;
          studentLng?: number;
          radiusKm?: number;
          durationMin?: number;
        },
        GetAvailableStudiosResult
      >(functions, 'getAvailableStudios');

      // 基準地点が決まっていれば半径で絞り込む（県境をまたいだ最寄りも候補になる）。
      // 決まっていなければ従来どおり都道府県・市区町村で絞り込む。
      const result = await getAvailableStudios({
        teacherId: teacherInfo.authUid,
        date: selectedDate,
        time: selectedTime,
        durationMin: lessonDurationMin,
        ...(searchCenter
          ? {
              studentLat: searchCenter.lat,
              studentLng: searchCenter.lng,
              radiusKm: searchRadiusKm,
            }
          : {
              prefecture: regionPref,
              city: regionCity || undefined,
            }),
      });

      const list = result.data?.studios ?? [];
      console.log('getAvailableStudios result:', list);
      setStudioResults(list);

      if (list.length === 0) {
        setStudioSearchError(
          searchCenter
            ? `この場所から${searchRadiusKm}km以内に、空きスタジオが見つかりませんでした。距離を広げるか、日時を変えてお試しください。`
            : '条件に合う空きスタジオが見つかりませんでした。地域や日時を変えてお試しください。'
        );
      }
    } catch (error: any) {
      console.error('スタジオ検索に失敗しました:', error);
      setStudioSearchError(error?.message || 'スタジオ検索に失敗しました。');
    } finally {
      setStudioSearching(false);
    }
  };

  const handleSelectStudio = (studio: AvailableStudio) => {
    setSelectedStudio(studio);
    // 予約に保存するレッスン場所をスタジオ名・住所で埋める
    const locationText = studio.address
      ? `${studio.name}（${studio.address}）`
      : studio.name;
    setFormData((prev) => ({ ...prev, location: locationText }));
    setErrors((prev) => ({ ...prev, location: '', studio: '' }));
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    let cleanValue = value;

    if (name === 'phone') {
      cleanValue = value.replace(/[^\d]/g, '');
    } else if (name === 'name' || name === 'furigana') {
      cleanValue = normalizeInput(value);
    }

    setFormData((prev) => ({
      ...prev,
      [name]: cleanValue,
    }));

    setErrors((prev) => ({
      ...prev,
      [name]: '',
    }));
  };

  const validate = () => {
    const newErrors: Record<string, string> = {};

    console.log('================ validate 実行ログ ================');
    console.log('teacherInfo:', teacherInfo);
    console.log('selectedDate:', selectedDate);
    console.log('selectedTime:', selectedTime);
    console.log('lessonAmount:', lessonAmount);
    console.log('formData:', formData);
    console.log('=================================================');

    if (!teacherInfo?.authUid) {
      newErrors.teacherId = '講師情報の取得に失敗しました';
    }

    if (!selectedDate) {
      newErrors.selectedDate = 'レッスン日を選択してください';
    }

    if (!selectedTime) {
      newErrors.selectedTime = '時間を選択してください';
    }

    if (!formData.name.trim()) {
      newErrors.name = 'お名前を入力してください';
    }

    if (!formData.furigana.trim()) {
      newErrors.furigana = 'フリガナを入力してください';
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(formData.email)) {
      newErrors.email = '正しいメールアドレスを入力してください';
    }

    const phoneRegex = /^\d{10,11}$/;
    if (!phoneRegex.test(formData.phone)) {
      newErrors.phone = '10～11桁の電話番号を入力してください';
    }

    if (isStudioFlow && !selectedStudio) {
      newErrors.studio = 'スタジオを検索して選択してください';
    }

    if (!formData.location.trim()) {
      newErrors.location = 'レッスン場所を入力してください';
    }

    if (lessonAmount === null || !Number.isInteger(lessonAmount) || lessonAmount < 50) {
      newErrors.lessonAmount = 'レッスン料金を判定できませんでした';
    }

    console.log('validate 結果 errors:', newErrors);

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleConfirm = (e: React.FormEvent) => {
    e.preventDefault();

    console.log('================ 確認画面へボタン押下 ================');
    console.log('auth.currentUser:', auth.currentUser);
    console.log('teacherInfo:', teacherInfo);
    console.log('selectedDate:', selectedDate);
    console.log('selectedTime:', selectedTime);
    console.log('formData:', formData);
    console.log('====================================================');

    const user = auth.currentUser;
    if (!user) {
      alert('ログインが必要です。ログインページへ移動します。');
      navigate('/login', {
        state: { from: `${location.pathname}${location.search}` },
      });
      return;
    }

    // 会員情報の読み込み前／未完のときは確認画面へ進めない
    if (!profileChecked) {
      alert('会員情報を読み込み中です。少し待ってから再度お試しください。');
      return;
    }
    if (missingProfileFields.length > 0) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    if (!validate()) return;

    // 履歴を1つ積む。ブラウザの戻るでこのエントリが外れ、入力画面に戻る。
    navigate(`${location.pathname}${location.search}`, {
      state: { ...(location.state as Record<string, unknown> | null), confirming: true },
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleBackToEdit = () => {
    console.log('入力画面に戻るボタン押下');
    // ブラウザの戻ると同じ挙動にして履歴の整合を保つ
    navigate(-1);
  };

  const handleFinalSubmit = async () => {
    const user = auth.currentUser;

    console.log('================ 最終送信ログ ================');
    console.log('auth.currentUser:', user);
    console.log('teacherInfo:', teacherInfo);
    console.log('selectedDate:', selectedDate);
    console.log('selectedTime:', selectedTime);
    console.log('lessonAmount:', lessonAmount);
    console.log('formData:', formData);
    console.log('============================================');

    if (!user) {
      alert('ログイン状態を確認できませんでした。再度ログインしてください。');
      navigate('/login', {
        state: { from: `${location.pathname}${location.search}` },
      });
      return;
    }

    if (!teacherInfo?.authUid) {
      alert('講師情報の取得に失敗しました。');
      return;
    }

    if (!validate()) {
      navigate(-1);
      return;
    }

    try {
      setSubmitting(true);

      const functions = getFunctions(undefined, 'us-central1');
      const createReservationAndCheckout = httpsCallable<
        CreateReservationAndCheckoutPayload,
        CreateReservationAndCheckoutResult
      >(functions, 'createReservationAndCheckout');

      const payload: CreateReservationAndCheckoutPayload = {
        teacherId: teacherInfo.authUid,
        teacherName: teacherInfo.name,
        teacherEmail: teacherInfo.email || '',
        lessonCourse,
        lessonAmount: lessonAmount!,
        date: selectedDate,
        time: selectedTime,
        name: formData.name,
        furigana: formData.furigana,
        email: formData.email,
        phone: formData.phone,
        location: formData.location,
        notes: formData.notes,
        paymentMethod,
        lessonType: displayLessonType || undefined,
        durationMin: lessonDurationMin,
        // 値引き額は送らない。サーバー側がクーポンを読み直して再計算する。
        ...(couponDiscount > 0 && selectedCouponId
          ? { couponId: selectedCouponId }
          : {}),
        ...(isStudioFlow && selectedStudio
          ? {
              studioId: selectedStudio.id,
              studioName: selectedStudio.name,
              studioFee: selectedStudio.pricePerSlot,
            }
          : {}),
      };

      console.log('Cloud Functions に送信する payload:', payload);

      const result = await createReservationAndCheckout(payload);
      const data = result.data;

      console.log('createReservationAndCheckout result:', result);
      console.log('createReservationAndCheckout data:', data);

      if (!data?.ok) {
        throw new Error('予約と決済画面の作成に失敗しました。');
      }

      if (!data.url) {
        throw new Error('Stripe Checkout のURLが取得できませんでした。');
      }

      window.location.href = data.url;
    } catch (error: any) {
      console.error('Stripe決済開始に失敗しました:', error);

      const message =
        typeof error?.message === 'string' && error.message
          ? error.message
          : '決済画面への遷移に失敗しました。';

      alert(`❌ ${message}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (teacherLoading) {
    return (
      <main className="about-section fade-in-up">
        <h2 className="centered-heading-with-border">
          <span>レッスン予約フォーム</span>
        </h2>
        <p style={{ textAlign: 'center', marginTop: '2rem' }}>
          講師情報を読み込み中です…
        </p>
      </main>
    );
  }

  return (
    <main className="about-section fade-in-up">
      <h2 className="centered-heading-with-border">
        <span>レッスン予約フォーム</span>
      </h2>

      {confirming ? (
        <div style={{ maxWidth: '640px', margin: '2rem auto' }}>
          <h3 style={{ marginBottom: '1.5rem' }}>以下の内容でお支払いへ進みますか？</h3>

          <div className="form-group">
            <p><strong>講師名：</strong>{teacherInfo?.name}</p>
            <p><strong>レッスンコース：</strong>{lessonCourse}</p>
            {displayLessonType && <p><strong>レッスン種別：</strong>{displayLessonType}</p>}
            <p><strong>日時：</strong>{selectedDate} {selectedTime}</p>
            <p><strong>レッスン料：</strong>{lessonAmount?.toLocaleString()}円</p>
            {isStudioFlow && selectedStudio && (
              <>
                <p><strong>スタジオ：</strong>{selectedStudio.name}</p>
                <p><strong>スタジオ代：</strong>{selectedStudio.pricePerSlot.toLocaleString()}円</p>
                <p><strong>小計：</strong>{subtotalAmount.toLocaleString()}円</p>
              </>
            )}
            {couponDiscount > 0 && selectedCoupon && (
              <>
                <p>
                  <strong>クーポン：</strong>
                  {selectedCoupon.name}（-{couponDiscount.toLocaleString()}円）
                </p>
                <p><strong>お支払い金額：</strong>{payableAmount.toLocaleString()}円</p>
              </>
            )}
            {displayLocationHint && (
              <p><strong>コース既定の場所：</strong>{displayLocationHint}</p>
            )}
            {displayCourseNote && (
              <p><strong>コース備考：</strong>{displayCourseNote}</p>
            )}
            <p><strong>お名前：</strong>{formData.name}</p>
            <p><strong>フリガナ：</strong>{formData.furigana}</p>
            <p><strong>メールアドレス：</strong>{formData.email}</p>
            <p><strong>電話番号：</strong>{formData.phone}</p>
            <p><strong>レッスン場所：</strong>{formData.location}</p>
            <p><strong>ご要望：</strong>{formData.notes || 'なし'}</p>
          </div>

          <div
            className="form-group"
            style={{
              border: '1px solid #ddd',
              borderRadius: 8,
              padding: '1rem',
              background: '#fafafa',
              marginTop: '1.5rem',
            }}
          >
            <label style={{ fontWeight: 'bold' }}>お支払い方法</label>
            <p style={{ margin: '0.5rem 0 0' }}>クレジットカード</p>
            <p style={{ color: '#666', fontSize: '0.85rem', margin: '0.25rem 0 0' }}>
              ご予約時点ではカードのお支払い枠を確保するだけで、請求は発生しません。
              レッスン前日にお支払いが確定します。前日23:59までにキャンセルされた場合、請求は発生しません。
            </p>
          </div>

          <div
            style={{
              display: 'flex',
              gap: '12px',
              justifyContent: 'center',
              marginTop: '2rem',
              flexWrap: 'wrap',
            }}
          >
            <button
              type="button"
              className="form-button"
              onClick={handleBackToEdit}
              disabled={submitting}
            >
              入力画面に戻る
            </button>

            <button
              type="button"
              className="form-button"
              onClick={handleFinalSubmit}
              disabled={submitting}
            >
              {submitting ? 'Stripe決済画面へ移動中…' : 'お支払いへ進む'}
            </button>
          </div>
        </div>
      ) : (
        <>
          {teacherInfo?.authUid ? (
            // 下書き復元が終わるまでカレンダーを描画しない。BookingCalendar は初期選択日を
            // マウント時にしか読まないため、先に描画すると復元した日時が反映されない。
            draftRestored ? (
              <>
                {console.log('BookingCalendar 描画:', {
                  teacherId: teacherInfo.authUid,
                  displayMonth,
                  selectedDate,
                  selectedTime,
                })}

                <BookingCalendar
                  teacherId={teacherInfo.authUid}
                  requiredMethod={displayLessonType}
                  displayMonth={displayMonth}
                  onChangeMonth={(nextMonth: Date) => {
                    console.log('BookingCalendar から月変更:', nextMonth);
                    setDisplayMonth(nextMonth);
                  }}
                  onDateTimeSelect={handleDateTimeSelect}
                  initialSelectedDate={selectedDate}
                  initialSelectedTime={selectedTime}
                />
              </>
            ) : (
              <p style={{ textAlign: 'center', marginTop: '2rem' }}>
                カレンダーを読み込み中です...
              </p>
            )
          ) : (
            <p style={{ textAlign: 'center', color: 'red', marginTop: '2rem' }}>
              講師情報が見つかりませんでした。講師ページから再度お試しください。
            </p>
          )}

          {(errors.selectedDate || errors.selectedTime || errors.teacherId || errors.lessonAmount) && (
            <div style={{ maxWidth: '600px', margin: '1rem auto 0' }}>
              {errors.teacherId && <p className="error">{errors.teacherId}</p>}
              {errors.selectedDate && <p className="error">{errors.selectedDate}</p>}
              {errors.selectedTime && <p className="error">{errors.selectedTime}</p>}
              {errors.lessonAmount && <p className="error">{errors.lessonAmount}</p>}
            </div>
          )}

          <form onSubmit={handleConfirm} style={{ maxWidth: '600px', margin: '2rem auto' }}>
            <div className="form-group">
              <label>講師名</label>
              <input
                type="text"
                value={teacherInfo?.name || teacherNameFromQuery || ''}
                className="form-control"
                disabled
              />
            </div>

            <div className="form-group">
              <label>レッスンコース</label>
              <input
                type="text"
                value={lessonCourse}
                className="form-control"
                disabled
              />
            </div>

            {displayLessonType && (
              <div className="form-group">
                <label>レッスン種別</label>
                <input
                  type="text"
                  value={displayLessonType}
                  className="form-control"
                  disabled
                />
              </div>
            )}

            <div className="form-group">
              <label>料金</label>
              <input
                type="text"
                value={lessonAmount ? `${lessonAmount.toLocaleString()}円` : ''}
                className="form-control"
                disabled
              />
              {isStudioFlow && selectedStudio && (
                <div style={{ marginTop: 8, fontSize: '0.9rem' }}>
                  <p style={{ margin: '2px 0' }}>
                    スタジオ代（{selectedStudio.name}）: {selectedStudio.pricePerSlot.toLocaleString()}円
                  </p>
                  <p style={{ margin: '2px 0', fontWeight: 'bold' }}>
                    小計: {subtotalAmount.toLocaleString()}円
                  </p>
                </div>
              )}
            </div>

            {/* クーポン。コード入力ではなく、付与済みの一覧から選ぶ方式。 */}
            {couponOptions.length > 0 && (
              <div className="form-group">
                <label>クーポン</label>
                <select
                  className="form-control"
                  value={selectedCouponId}
                  onChange={(e) => setSelectedCouponId(e.target.value)}
                >
                  <option value="">使用しない</option>
                  {couponOptions.map((c) => {
                    const judged = judgeCouponUsable(c, subtotalAmount);
                    return (
                      <option key={c.id} value={c.id} disabled={!judged.usable}>
                        {c.name}（{c.discountAmount.toLocaleString()}円引き）
                        {judged.usable
                          ? ` / ${formatCouponExpiry(c)}`
                          : ` / ${judged.reason}`}
                      </option>
                    );
                  })}
                </select>

                {selectedCoupon && (
                  <p style={{ margin: '6px 0 0', fontSize: '0.85rem', color: '#555' }}>
                    {selectedCoupon.terms || '他のクーポンとの併用はできません。'}
                  </p>
                )}

                <div style={{ marginTop: 8, fontSize: '0.9rem' }}>
                  {couponDiscount > 0 && (
                    <p style={{ margin: '2px 0' }}>
                      クーポン値引き: -{couponDiscount.toLocaleString()}円
                    </p>
                  )}
                  <p style={{ margin: '2px 0', fontWeight: 'bold' }}>
                    お支払い金額: {payableAmount.toLocaleString()}円
                  </p>
                </div>

                <p style={{ margin: '6px 0 0', fontSize: '0.8rem', color: '#777' }}>
                  クーポンは1回のご予約につき1枚まで、他のクーポンとの併用はできません。
                  現金への交換はできません。
                </p>
              </div>
            )}

            {displayLocationHint && (
              <div className="form-group">
                <label>コース既定の場所</label>
                <input
                  type="text"
                  value={displayLocationHint}
                  className="form-control"
                  disabled
                />
              </div>
            )}

            {displayCourseNote && (
              <div className="form-group">
                <label>コース備考</label>
                <textarea
                  value={displayCourseNote}
                  className="form-control"
                  rows={2}
                  disabled
                />
              </div>
            )}

            <div className="form-group">
              <label>選択した日時</label>
              <input
                type="text"
                value={
                  selectedDate && selectedTime
                    ? `${selectedDate} ${selectedTime}`
                    : 'カレンダーから選択してください'
                }
                className="form-control"
                disabled
              />
            </div>

            {isStudioFlow && (
              <div
                className="form-group"
                style={{
                  border: '1px solid #ddd',
                  borderRadius: 8,
                  padding: '1rem',
                  background: '#fafafa',
                }}
              >
                <label style={{ fontWeight: 'bold' }}>スタジオを検索して選択</label>
                <p style={{ fontSize: '0.85rem', color: '#666', margin: '0.25rem 0 0.75rem' }}>
                  基準にする場所を「住所」か「最寄り駅」で指定すると、そこから近い順に
                  空きスタジオを表示します。（講師が対応できるエリアのスタジオのみ表示されます）
                </p>

                {/* 基準地点の指定方法 */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  {(
                    [
                      { key: 'address', label: '住所から探す' },
                      { key: 'station', label: '最寄り駅から探す' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => {
                        setStudioSearchMode(tab.key);
                        if (tab.key === 'address') {
                          // 駅の候補一覧は住所モードでは意味を持たないので消す
                          resetStationSearch();
                          setSelectedStation(null);
                        }
                        setStudioResults([]);
                        setSelectedStudio(null);
                        setStudioSearchError('');
                      }}
                      style={{
                        flex: '1 1 auto',
                        padding: '0.5rem 0.75rem',
                        borderRadius: 6,
                        cursor: 'pointer',
                        border:
                          studioSearchMode === tab.key
                            ? '2px solid #b8a06a'
                            : '1px solid #ccc',
                        background: studioSearchMode === tab.key ? '#fff8e9' : '#fff',
                        fontWeight: studioSearchMode === tab.key ? 'bold' : 'normal',
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {studioSearchMode === 'station' && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <input
                        type="text"
                        value={stationKeyword}
                        onChange={(e) => setStationKeyword(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            setSelectedStation(null);
                            runStationSearch(stationKeyword);
                          }
                        }}
                        placeholder="駅名（例：渋谷）"
                        maxLength={50}
                        className="form-control"
                        style={{ flex: '1 1 200px' }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedStation(null);
                          setStudioResults([]);
                          setSelectedStudio(null);
                          setStudioSearchError('');
                          runStationSearch(stationKeyword);
                        }}
                        disabled={stationLoading}
                        className="form-button"
                        style={{ flex: '0 0 auto' }}
                      >
                        {stationLoading ? '検索中…' : '駅を検索'}
                      </button>
                    </div>

                    {stationError && (
                      <p style={{ fontSize: '0.8rem', color: '#a66', margin: '0.4rem 0 0' }}>
                        {stationError}
                      </p>
                    )}

                    {stationOptions.length > 0 && (
                      <div
                        style={{
                          marginTop: 8,
                          maxHeight: 200,
                          overflowY: 'auto',
                          border: '1px solid #ddd',
                          borderRadius: 6,
                          background: '#fff',
                        }}
                      >
                        {stationOptions.map((st) => (
                          <label
                            key={`${st.prefecture}/${st.name}`}
                            style={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: 8,
                              padding: '0.5rem 0.7rem',
                              borderBottom: '1px solid #eee',
                              cursor: 'pointer',
                              fontWeight: 'normal',
                            }}
                          >
                            <input
                              type="radio"
                              name="station"
                              checked={
                                selectedStation?.name === st.name &&
                                selectedStation?.prefecture === st.prefecture
                              }
                              onChange={() => {
                                setSelectedStation(st);
                                setStudioResults([]);
                                setSelectedStudio(null);
                                setStudioSearchError('');
                              }}
                              style={{ marginTop: 4 }}
                            />
                            <span>
                              <strong>{st.name}駅</strong>
                              <span style={{ color: '#666', fontSize: '0.85rem' }}>
                                （{st.prefecture}）
                              </span>
                              <br />
                              <span style={{ fontSize: '0.8rem', color: '#666' }}>
                                {st.lines.join('・')}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div
                  style={{
                    display: studioSearchMode === 'address' ? 'flex' : 'none',
                    gap: 8,
                    flexWrap: 'wrap',
                  }}
                >
                  <select
                    value={regionPref}
                    onChange={(e) => {
                      setRegionPref(e.target.value);
                      setRegionCity('');
                      setRegionTown('');
                      // 地域が変わると検索結果は無効になるためリセット
                      setStudioResults([]);
                      setSelectedStudio(null);
                      setStudioSearchError('');
                    }}
                    className="form-control"
                    style={{ flex: '1 1 160px' }}
                  >
                    <option value="">都道府県を選択</option>
                    {prefectures.map((p) => (
                      <option key={p.code} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>

                  <select
                    value={regionCity}
                    onChange={(e) => {
                      setRegionCity(e.target.value);
                      setRegionTown('');
                      setStudioResults([]);
                      setSelectedStudio(null);
                      setStudioSearchError('');
                    }}
                    className="form-control"
                    style={{ flex: '1 1 160px' }}
                    disabled={!regionPref || regionCityOptions.length === 0}
                  >
                    <option value="">市区町村（任意）</option>
                    {regionCityOptions.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>

                  <select
                    value={regionTown}
                    onChange={(e) => {
                      setRegionTown(e.target.value);
                      setStudioResults([]);
                      setSelectedStudio(null);
                      setStudioSearchError('');
                    }}
                    className="form-control"
                    style={{ flex: '1 1 160px' }}
                    disabled={
                      !regionCity ||
                      regionTownsLoading ||
                      regionTownOptions.length === 0
                    }
                  >
                    <option value="">
                      {regionTownsLoading ? '町名を読込中…' : '町名（任意・近い順に表示）'}
                    </option>
                    {regionTownOptions.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>

                {studioSearchMode === 'address' && regionCity && regionTownsError && (
                  <p style={{ fontSize: '0.8rem', color: '#a66', margin: '0.25rem 0 0' }}>
                    町名候補を取得できませんでした（町名なしでも検索できます）。
                  </p>
                )}

                {/* 検索範囲。基準地点が決まっているときだけ距離で絞り込める */}
                <div style={{ marginTop: 12 }}>
                  <label htmlFor="studio-radius" style={{ fontSize: '0.9rem' }}>
                    検索範囲
                  </label>
                  <select
                    id="studio-radius"
                    value={searchRadiusKm}
                    onChange={(e) => {
                      setSearchRadiusKm(Number(e.target.value));
                      setStudioResults([]);
                      setSelectedStudio(null);
                      setStudioSearchError('');
                    }}
                    className="form-control"
                    disabled={!searchCenter}
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  >
                    {[3, 5, 10, 20].map((km) => (
                      <option key={km} value={km}>
                        この場所から{km}km以内
                      </option>
                    ))}
                  </select>
                  <p style={{ fontSize: '0.8rem', color: '#666', margin: '0.4rem 0 0' }}>
                    {searchCenter
                      ? studioSearchMode === 'station'
                        ? `基準地点：${selectedStation?.name}駅`
                        : `基準地点：${regionPref}${regionCity}${regionTown}`
                      : studioSearchMode === 'station'
                        ? '駅を選択すると、その駅からの距離で絞り込めます。'
                        : '市区町村（できれば町名）まで選ぶと、そこからの距離で絞り込めます。'}
                  </p>
                </div>

                <button
                  type="button"
                  className="form-button"
                  onClick={handleSearchStudios}
                  disabled={studioSearching}
                  style={{ marginTop: 12 }}
                >
                  {studioSearching ? '検索中…' : '空きスタジオを検索'}
                </button>

                {studioSearchError && (
                  <p className="error" style={{ marginTop: 8 }}>
                    {studioSearchError}
                  </p>
                )}

                {studioResults.length > 0 && (
                  <div
                    style={{
                      marginTop: 12,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    {studioResults.map((s) => (
                      <label
                        key={s.id}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 8,
                          border:
                            selectedStudio?.id === s.id
                              ? '2px solid #4caf7d'
                              : '1px solid #ccc',
                          borderRadius: 6,
                          padding: '0.6rem 0.8rem',
                          cursor: 'pointer',
                          background: '#fff',
                        }}
                      >
                        <input
                          type="radio"
                          name="studio"
                          checked={selectedStudio?.id === s.id}
                          onChange={() => handleSelectStudio(s)}
                          style={{ marginTop: 4 }}
                        />
                        <span>
                          <strong>{s.name}</strong>
                          {(typeof s.studentDistanceKm === 'number' ||
                            typeof s.distanceKm === 'number') && (
                            <span style={{ color: '#666', fontSize: '0.85rem' }}>
                              （
                              {typeof s.studentDistanceKm === 'number' &&
                                `指定した場所から約${s.studentDistanceKm}km`}
                              {typeof s.studentDistanceKm === 'number' &&
                                typeof s.distanceKm === 'number' &&
                                '／'}
                              {typeof s.distanceKm === 'number' &&
                                `講師拠点から約${s.distanceKm}km`}
                              ）
                            </span>
                          )}
                          <br />
                          {s.address && (
                            <span style={{ fontSize: '0.85rem', color: '#666' }}>
                              {s.address}
                              <br />
                            </span>
                          )}
                          <span>スタジオ代: {s.pricePerSlot.toLocaleString()}円</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}

                {errors.studio && (
                  <p className="error" style={{ marginTop: 8 }}>
                    {errors.studio}
                  </p>
                )}
              </div>
            )}

            {/* ご予約者情報は会員情報から自動反映。未入力があれば会員情報の入力を促す */}
            <div
              className="form-group"
              style={{
                border: '1px solid #ddd',
                borderRadius: 8,
                padding: '1rem',
                background: '#fafafa',
              }}
            >
              <label style={{ fontWeight: 'bold' }}>ご予約者情報</label>
              {!authUser ? (
                <p style={{ margin: '0.25rem 0 0' }}>
                  ご予約にはログインが必要です。ログインすると会員情報が自動で反映されます。
                </p>
              ) : missingProfileFields.length === 0 ? (
                <>
                  <p style={{ fontSize: '0.85rem', color: '#666', margin: '0.25rem 0 0.5rem' }}>
                    会員情報から自動で反映されます。変更する場合は
                    <Link to="/profile">会員情報の編集</Link>から行ってください。
                  </p>
                  <p style={{ margin: '2px 0' }}>
                    <strong>お名前：</strong>
                    {formData.name}（{formData.furigana}）
                  </p>
                  <p style={{ margin: '2px 0' }}>
                    <strong>メール：</strong>
                    {formData.email}
                  </p>
                  <p style={{ margin: '2px 0' }}>
                    <strong>電話番号：</strong>
                    {formData.phone}
                  </p>
                </>
              ) : (
                <p className="error" style={{ margin: '0.25rem 0 0' }}>
                  会員情報に未入力の項目（{missingProfileFields.join('・')}）があります。
                  <Link to="/profile">会員情報の編集</Link>
                  から入力を完了してからご予約ください。
                </p>
              )}
            </div>

            <div className="form-group">
              <label>レッスン場所</label>
              {isOnlineFlow ? (
                <>
                  <input
                    type="text"
                    name="location"
                    value="オンライン"
                    className="form-control"
                    disabled
                  />
                  <p style={{ fontSize: '0.85rem', color: '#666', margin: '0.4rem 0 0' }}>
                    ビデオ通話で行います。参加URLは予約確定後に講師が登録し、
                    マイページと前日のリマインドメールでご案内します。
                  </p>
                </>
              ) : (
                <input
                  type="text"
                  name="location"
                  value={formData.location}
                  onChange={handleChange}
                  className="form-control"
                />
              )}
              {errors.location && <p className="error">{errors.location}</p>}
            </div>

            <div className="form-group">
              <label>ご要望など</label>
              <textarea
                name="notes"
                value={formData.notes}
                onChange={handleChange}
                className="form-control"
                rows={4}
              />
            </div>

            <button
              type="submit"
              className="form-button"
              disabled={!!authUser && (!profileChecked || missingProfileFields.length > 0)}
            >
              確認画面へ
            </button>
          </form>
        </>
      )}
    </main>
  );
};

export default ReservationForm;