/** Only inside ui.html; handler logic runs in QuickJS. */
declare const pcbjamUI:{ready:Promise<void>;call(command:string,params?:unknown):Promise<any>};
