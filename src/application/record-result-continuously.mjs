/** Resume only a verified, unchanged registration operation; never rerun an Agent. */
export const recordResultContinuously=async(api,projectId,runId,dispatchId,result,options)=>{
 for(;;)try{return await api.recordResult(projectId,runId,dispatchId,result,options);}
 catch(error){
   const recovery=await api.reserveResultRegistrationRecovery(projectId,runId,dispatchId,result,options,error);
   if(!recovery)throw error;
   options.onVerificationProgress?.({phase:'result-registration-recovery',fault:recovery});
 }
};
