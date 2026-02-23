'use client';

import { useEffect, useState } from 'react';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import { supabase } from '@/lib/supabaseClient';
import type { Profile } from '@/lib/types';
import type { City } from '@/lib/types';

export default function AdminUsersPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [editProfile, setEditProfile] = useState<Profile | null>(null);
  const [linkForm, setLinkForm] = useState({
    user_id: '',
    display_name: '',
    role: 'seller' as 'admin' | 'seller',
    city_id: '',
    is_active: true,
  });
  const [editForm, setEditForm] = useState({
    display_name: '',
    role: 'seller' as 'admin' | 'seller',
    city_id: '',
    is_active: true,
  });

  useEffect(() => {
    load();
    supabase.from('cities').select('*').then(({ data }) => setCities(data || []));
  }, []);

  async function load() {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .order('display_name');
    setProfiles(data || []);
    setLoading(false);
  }

  async function handleLink() {
    if (!linkForm.user_id.trim() || !linkForm.display_name.trim()) {
      alert('Введите user_id и display_name');
      return;
    }

    const { error } = await supabase.from('profiles').upsert(
      {
        id: linkForm.user_id,
        display_name: linkForm.display_name,
        role: linkForm.role,
        city_id: linkForm.city_id || null,
        is_active: linkForm.is_active,
      },
      { onConflict: 'id' }
    );

    if (error) {
      alert(error.message);
      return;
    }

    setLinkForm({
      user_id: '',
      display_name: '',
      role: 'seller',
      city_id: '',
      is_active: true,
    });
    setShowLinkForm(false);
    load();
  }

  async function handleEdit() {
    if (!editProfile) return;

    const { error } = await supabase
      .from('profiles')
      .update({
        display_name: editForm.display_name,
        role: editForm.role,
        city_id: editForm.city_id || null,
        is_active: editForm.is_active,
      })
      .eq('id', editProfile.id);

    if (error) {
      alert(error.message);
      return;
    }

    setEditProfile(null);
    load();
  }

  const cityMap = new Map(cities.map((c) => [c.id, c.name]));

  return (
    <Protected role="admin">
      <div className="min-h-screen">
        <NavAdmin />
        <div className="p-4">
          <h1 className="text-2xl font-bold mb-4">Продавцы и пользователи</h1>

          <div className="mb-4 p-4 bg-amber-50 rounded-lg">
            <p className="text-sm font-medium mb-2">Инструкция по созданию пользователя:</p>
            <ol className="text-sm list-decimal list-inside space-y-1 text-gray-700">
              <li>Откройте Supabase Dashboard → Authentication → Users</li>
              <li>Нажмите Add user → Create new user</li>
              <li>Введите email и пароль</li>
              <li>Скопируйте User ID (UUID) созданного пользователя</li>
              <li>Ниже нажмите «Привязать пользователя» и введите данные</li>
            </ol>
          </div>

          <button
            onClick={() => setShowLinkForm(true)}
            className="px-4 py-2 bg-green-600 text-white rounded-lg mb-4"
          >
            Привязать пользователя
          </button>

          {showLinkForm && (
            <div className="bg-gray-50 rounded-lg p-4 mb-4">
              <h2 className="font-bold mb-2">Привязать пользователя</h2>
              <input
                placeholder="User ID (UUID из auth.users)"
                value={linkForm.user_id}
                onChange={(e) => setLinkForm({ ...linkForm, user_id: e.target.value })}
                className="w-full px-3 py-2 border rounded mb-2"
              />
              <input
                placeholder="Display name"
                value={linkForm.display_name}
                onChange={(e) => setLinkForm({ ...linkForm, display_name: e.target.value })}
                className="w-full px-3 py-2 border rounded mb-2"
              />
              <select
                value={linkForm.role}
                onChange={(e) =>
                  setLinkForm({
                    ...linkForm,
                    role: e.target.value as 'admin' | 'seller',
                  })
                }
                className="w-full px-3 py-2 border rounded mb-2"
              >
                <option value="seller">Продавец</option>
                <option value="admin">Админ</option>
              </select>
              <select
                value={linkForm.city_id}
                onChange={(e) => setLinkForm({ ...linkForm, city_id: e.target.value })}
                className="w-full px-3 py-2 border rounded mb-2"
              >
                <option value="">Без города</option>
                {cities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 mb-2">
                <input
                  type="checkbox"
                  checked={linkForm.is_active}
                  onChange={(e) => setLinkForm({ ...linkForm, is_active: e.target.checked })}
                />
                Активен
              </label>
              <div className="flex gap-2">
                <button
                  onClick={handleLink}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg"
                >
                  Сохранить
                </button>
                <button
                  onClick={() => setShowLinkForm(false)}
                  className="px-4 py-2 bg-gray-300 rounded-lg"
                >
                  Отмена
                </button>
              </div>
            </div>
          )}

          {editProfile && (
            <div className="bg-gray-50 rounded-lg p-4 mb-4">
              <h2 className="font-bold mb-2">Редактирование профиля</h2>
              <input
                placeholder="Display name"
                value={editForm.display_name}
                onChange={(e) => setEditForm({ ...editForm, display_name: e.target.value })}
                className="w-full px-3 py-2 border rounded mb-2"
              />
              <select
                value={editForm.role}
                onChange={(e) =>
                  setEditForm({ ...editForm, role: e.target.value as 'admin' | 'seller' })
                }
                className="w-full px-3 py-2 border rounded mb-2"
              >
                <option value="seller">Продавец</option>
                <option value="admin">Админ</option>
              </select>
              <select
                value={editForm.city_id}
                onChange={(e) => setEditForm({ ...editForm, city_id: e.target.value })}
                className="w-full px-3 py-2 border rounded mb-2"
              >
                <option value="">Без города</option>
                {cities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 mb-2">
                <input
                  type="checkbox"
                  checked={editForm.is_active}
                  onChange={(e) => setEditForm({ ...editForm, is_active: e.target.checked })}
                />
                Активен
              </label>
              <div className="flex gap-2">
                <button
                  onClick={handleEdit}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg"
                >
                  Сохранить
                </button>
                <button
                  onClick={() => setEditProfile(null)}
                  className="px-4 py-2 bg-gray-300 rounded-lg"
                >
                  Отмена
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <p>Загрузка...</p>
          ) : (
            <div className="space-y-2">
              {profiles.map((p) => (
                <div
                  key={p.id}
                  className="flex justify-between items-center p-4 bg-gray-50 rounded-lg"
                >
                  <div>
                    <p className="font-medium">
                      {p.display_name || p.id.slice(0, 8)} · {p.role}
                    </p>
                    <p className="text-sm text-gray-500">
                      ID: {p.id.slice(0, 8)}... · Город: {cityMap.get(p.city_id || '') || '-'}
                      {!p.is_active && ' · Неактивен'}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setEditProfile(p);
                      setEditForm({
                        display_name: p.display_name || '',
                        role: p.role,
                        city_id: p.city_id || '',
                        is_active: p.is_active,
                      });
                    }}
                    className="px-3 py-1 bg-blue-600 text-white rounded text-sm"
                  >
                    Редактировать
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Protected>
  );
}
