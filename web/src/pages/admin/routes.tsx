import { Route, Routes } from 'react-router-dom';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { AnalyticsPage, DashboardPage, ReconciliationPage } from './Dashboard';
import { EnquiriesPage, OrderDetailPage, OrdersPage } from './Orders';
import { CategoriesPage, ProductFormPage, ProductsPage, StakeholdersPage } from './Catalog';
import { DistributorsPage, InventoryPage, LocationsPage, RestocksPage, TransfersPage } from './Stock';
import { ExpensesPage, FinancePage, LedgerPage, SettlementsPage } from './Finance';
import { AuditLogsPage, ImportExportPage, SettingsPage } from './Tools';
import { AssistantPage } from './Assistant';

export default function AdminRoutes() {
  return (
    <Routes>
      <Route element={<AdminLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="orders/:id" element={<OrderDetailPage />} />
        <Route path="enquiries" element={<EnquiriesPage />} />
        <Route path="reconciliation" element={<ReconciliationPage />} />
        <Route path="products" element={<ProductsPage />} />
        <Route path="products/:id" element={<ProductFormPage />} />
        <Route path="categories" element={<CategoriesPage />} />
        <Route path="stakeholders" element={<StakeholdersPage />} />
        <Route path="stakeholders/:id" element={<StakeholdersPage />} />
        <Route path="locations" element={<LocationsPage />} />
        <Route path="distributors" element={<DistributorsPage />} />
        <Route path="distributors/:id" element={<DistributorsPage />} />
        <Route path="inventory" element={<InventoryPage />} />
        <Route path="inventory/transfers" element={<TransfersPage />} />
        <Route path="inventory/restocks" element={<RestocksPage />} />
        <Route path="finance" element={<FinancePage />} />
        <Route path="finance/expenses" element={<ExpensesPage />} />
        <Route path="finance/transactions" element={<LedgerPage />} />
        <Route path="finance/settlements" element={<SettlementsPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="import-export" element={<ImportExportPage />} />
        <Route path="ai-assistant" element={<AssistantPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="audit-logs" element={<AuditLogsPage />} />
      </Route>
    </Routes>
  );
}
