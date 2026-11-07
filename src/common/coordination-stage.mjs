/** Observed states only. Reservations and silence never prove that work started. */
export const coordinationStage=({lease=null,effect=null,registration=null,process=null,userStopped=false}={})=>{
 if(userStopped)return {stage:'stopped',action:'preserve-and-stop'};
 if(registration?.stage==='submitted')return {stage:'registered',action:'advance'};
 if(registration?.stage==='verified')return {stage:'verified-awaiting-registration',action:'reconcile-registration'};
 if(process?.state==='running'&&process.supervised===true)return {stage:'verification-running',action:'observe-process'};
 if(effect?.state==='settled'&&effect.outcome?.disposition==='result-observed')return {stage:'result-observed',action:'validate-result'};
 if(lease?.status==='active'&&effect?.state==='lease-bound')return {stage:'agent-running',action:'observe-agent'};
 if(effect&&['spawn-requested','spawn-responded','agent-observed'].includes(effect.state))return {stage:'spawn-unconfirmed',action:'reconcile-effect'};
 return {stage:'not-started-or-unverified',action:'inspect-before-waiting'};
};
