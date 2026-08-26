import React, { useState } from 'react';
import '../index.css';

const TeacherSchedule: React.FC = () => {
  const [selectedDate, setSelectedDate] = useState('');
  const [availability, setAvailability] = useState<{ [time: string]: boolean }>({});

  const times = [
    '10:00', '10:30',
    '11:00', '11:30', '12:00', '12:30',
    '13:00', '13:30', '14:00', '14:30',
    '15:00', '15:30', '16:00', '16:30',
    '17:00', '17:30', '18:00', '18:30',
    '19:00', '19:30', '20:00',
  ];

  const handleCheckboxChange = (time: string) => {
    setAvailability({
      ...availability,
      [time]: !availability[time],
    });
  };

  const handleSave = () => {
    if (!selectedDate) {
      alert('日付を選択してください');
      return;
    }

    // Firebase 保存の代わりに console 表示
    console.log('保存内容：', {
      date: selectedDate,
      times: availability,
    });
    alert('スケジュールを保存しました（仮動作）');
  };

  return (
    <main className="about-section fade-in-up">
      <h2 style={{ textAlign: 'center', fontSize: '1.6rem', fontWeight: 'bold' }}>
        講師スケジュール登録
      </h2>

      <div style={{ maxWidth: '600px', margin: '2rem auto' }}>
        <label>
          日付を選択：
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            required
          />
        </label>

        <div style={{ marginTop: '1.5rem' }}>
          <p>空いている時間帯にチェックを入れてください：</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
            {times.map((time) => (
              <label key={time} style={{ marginBottom: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={!!availability[time]}
                  onChange={() => handleCheckboxChange(time)}
                />{' '}
                {time}
              </label>
            ))}
          </div>
        </div>

        <button type="button" onClick={handleSave} style={{ marginTop: '1rem' }}>保存</button>
      </div>
    </main>
  );
};

export default TeacherSchedule;
