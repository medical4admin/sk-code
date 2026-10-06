import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import IndexPage from "@/pages/Index";
import InformationPage from "@/pages/Information";
import FeedbackPage from "@/pages/Feedback";
import AdminPage from "@/pages/Admin";
import AdminScriptsPage from "@/pages/AdminScripts";
import NotFound from "@/pages/not-found";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { loadSiteScripts, unloadSiteScripts } from "@/lib/scriptLoader";
function Router() {
    const ownerDashboardHost = import.meta.env.VITE_OWNER_DASHBOARD_HOST;
    const showOwnerDashboard = Boolean(ownerDashboardHost && window.location.hostname === ownerDashboardHost);
    const [location] = useLocation();
    useEffect(() => {
        let cancelled = false;
        unloadSiteScripts();
        void loadSiteScripts(location).then(() => {
            if (cancelled)
                unloadSiteScripts();
        });
        return () => { cancelled = true; unloadSiteScripts(); };
    }, [location]);
    return (<Switch>
      <Route path="/" component={IndexPage}/>
      <Route path="/guide"><InformationPage kind="guide"/></Route>
      <Route path="/privacy"><InformationPage kind="privacy"/></Route>
      <Route path="/terms"><InformationPage kind="terms"/></Route>
      <Route path="/feedback" component={FeedbackPage}/>
      {showOwnerDashboard ? <Route path="/admin" component={AdminPage}/> : null}
      {showOwnerDashboard ? <Route path="/admin/scripts" component={AdminScriptsPage}/> : null}
      <Route component={NotFound}/>
    </Switch>);
}
const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
export default function App() {
    return (<ErrorBoundary>
      <WouterRouter base={BASE}>
        <Router />
      </WouterRouter>
    </ErrorBoundary>);
}
