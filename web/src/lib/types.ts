export type Role = 'super_admin' | 'manager' | 'inventory_manager' | 'finance_manager' | 'order_manager' | 'distributor';

export type StoreProduct = {
  id: string; name: string; slug: string; description: string | null; images: string[]; unit: string; price: number;
  is_featured: boolean; created_at: string; category_id: string; category_name: string; category_slug: string;
  available_qty: number; sold_90d: number;
};
export type StoreCategory = { id: string; name: string; slug: string; description: string | null; sort_order: number; product_count: number };
export type Institution = { id: string; name: string; short_name: string | null; is_active: boolean; sort_order: number; hostels?: Hostel[] };
export type Hostel = { id: string; institution_id: string; name: string; is_active: boolean; sort_order: number };

export type CartLine = { product_id: string; name: string; price: number; unit: string; quantity: number; image?: string; max?: number };

export type Quote = {
  ok: boolean; errors: string[]; items: { product_id: string; name: string; unit: string; quantity: number; unit_price: number; line_total: number }[];
  subtotal: number; delivery_fee: number; total: number; delivery_method: 'distributor' | 'courier'; supported_location: boolean;
  courier_fallback: boolean; split: boolean; unavailable: { product_id: string; name: string; requested: number; available: number }[];
  manual_fulfilment: boolean; courier_note: string;
};

export type Contact = { label: string; name?: string; phone?: string; handle?: string };
export type PublicOrder = {
  reference: string; status: string; payment_status: string; created_at: string; delivered_at: string | null; customer_name: string;
  phone_masked: string; delivery_method: 'distributor' | 'courier'; location_type: 'on_campus' | 'off_campus'; institution_name: string | null;
  hostel_name: string | null; room_number: string | null; address_line: string | null; delivery_instructions: string | null;
  subtotal: number; delivery_fee: number; discount: number; total: number; amount_paid: number;
  courier: { name: string | null; phone: string | null; tracking: string | null } | null;
  items: { product_id: string; name: string; unit: string; quantity: number; unit_price: number; line_total: number }[];
  timeline: { status: string; at: string }[];
  contacts: { primary: Contact[]; backup: Contact[] };
  access_token?: string;
};

export type OrderPayload = {
  items: { product_id: string; quantity: number }[];
  customer: { name: string; phone: string; alt_phone?: string | null; email?: string | null };
  location: { type: 'on_campus' | 'off_campus'; institution_id?: string | null; hostel_id?: string | null; room_number?: string | null;
    address_line?: string | null; digital_address?: string | null; instructions?: string | null };
  source?: 'web' | 'assistant';
};
