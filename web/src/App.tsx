import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from '@/hooks/auth';
import { CartProvider } from '@/hooks/cart';
import { SettingsProvider } from '@/hooks/settings';
import { Loading, ToastProvider } from '@/components/ui';
import { PublicLayout } from '@/components/public/Layout';
import { isConfigured } from '@/lib/neon';
import Home from '@/pages/public/Home';
import Shop, { ProductPage } from '@/pages/public/Shop';
import Checkout, { CartPage } from '@/pages/public/Checkout';
import { CustomerService, Enquiries, OrderConfirmation, TrackOrder } from '@/pages/public/Orders';
import Account from '@/pages/public/Account';

// The admin panel is loaded only when someone opens /admin, keeping the shop fast.
const Admin = lazy(() => import('@/pages/admin/routes'));

function ScrollTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

export default function App() {
  if (!isConfigured) return (
    <div className="mx-auto max-w-lg px-6 py-20">
      <h1 className="text-3xl">Almost there</h1>
      <p className="mt-3 text-charcoal-500">Add <code>VITE_NEON_AUTH_URL</code> and <code>VITE_NEON_DATA_API_URL</code> to <code>web/.env</code> (or your Vercel project settings), then reload. See README.md.</p>
    </div>
  );
  return (
    <ToastProvider>
      <AuthProvider>
        <SettingsProvider>
          <CartProvider>
            <ScrollTop />
            <Routes>
              <Route element={<PublicLayout />}>
                <Route index element={<Home />} />
                <Route path="shop" element={<Shop />} />
                <Route path="category/:slug" element={<Shop />} />
                <Route path="product/:slug" element={<ProductPage />} />
                <Route path="cart" element={<CartPage />} />
                <Route path="checkout" element={<Navigate to="/checkout/location" replace />} />
                <Route path="checkout/:step" element={<Checkout />} />
                <Route path="order-confirmation/:reference" element={<OrderConfirmation />} />
                <Route path="track-order" element={<TrackOrder />} />
                <Route path="enquiries" element={<Enquiries />} />
                <Route path="account" element={<Account />} />
                <Route path="account/orders" element={<Account />} />
                <Route path="account/addresses" element={<Account />} />
                <Route path="customer-service" element={<CustomerService />} />
              </Route>
              <Route path="admin/*" element={<Suspense fallback={<div className="p-8"><Loading /></div>}><Admin /></Suspense>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </CartProvider>
        </SettingsProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
