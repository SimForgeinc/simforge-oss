(()=>{var tb=Object.create;var ox=Object.defineProperty;var ab=Object.getOwnPropertyDescriptor;var nb=Object.getOwnPropertyNames;var ib=Object.getPrototypeOf,sb=Object.prototype.hasOwnProperty;var In=(t,e)=>()=>{try{return e||t((e={exports:{}}).exports,e),e.exports}catch(a){throw e=0,a}};var rb=(t,e,a,n)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of nb(e))!sb.call(t,i)&&i!==a&&ox(t,i,{get:()=>e[i],enumerable:!(n=ab(e,i))||n.enumerable});return t};var Ua=(t,e,a)=>(a=t!=null?tb(ib(t)):{},rb(e||!t||!t.__esModule?ox(a,"default",{value:t,enumerable:!0}):a,t));var vx=In(Pe=>{"use strict";var Yd=Symbol.for("react.transitional.element"),ob=Symbol.for("react.portal"),lb=Symbol.for("react.fragment"),ub=Symbol.for("react.strict_mode"),cb=Symbol.for("react.profiler"),fb=Symbol.for("react.consumer"),db=Symbol.for("react.context"),hb=Symbol.for("react.forward_ref"),pb=Symbol.for("react.suspense"),mb=Symbol.for("react.memo"),dx=Symbol.for("react.lazy"),gb=Symbol.for("react.activity"),lx=Symbol.iterator;function xb(t){return t===null||typeof t!="object"?null:(t=lx&&t[lx]||t["@@iterator"],typeof t=="function"?t:null)}var hx={isMounted:function(){return!1},enqueueForceUpdate:function(){},enqueueReplaceState:function(){},enqueueSetState:function(){}},px=Object.assign,mx={};function or(t,e,a){this.props=t,this.context=e,this.refs=mx,this.updater=a||hx}or.prototype.isReactComponent={};or.prototype.setState=function(t,e){if(typeof t!="object"&&typeof t!="function"&&t!=null)throw Error("takes an object of state variables to update or a function which returns an object of state variables.");this.updater.enqueueSetState(this,t,e,"setState")};or.prototype.forceUpdate=function(t){this.updater.enqueueForceUpdate(this,t,"forceUpdate")};function gx(){}gx.prototype=or.prototype;function Zd(t,e,a){this.props=t,this.context=e,this.refs=mx,this.updater=a||hx}var Kd=Zd.prototype=new gx;Kd.constructor=Zd;px(Kd,or.prototype);Kd.isPureReactComponent=!0;var ux=Array.isArray;function Xd(){}var xt={H:null,A:null,T:null,S:null},xx=Object.prototype.hasOwnProperty;function Jd(t,e,a){var n=a.ref;return{$$typeof:Yd,type:t,key:e,ref:n!==void 0?n:null,props:a}}function vb(t,e){return Jd(t.type,e,t.props)}function Qd(t){return typeof t=="object"&&t!==null&&t.$$typeof===Yd}function yb(t){var e={"=":"=0",":":"=2"};return"$"+t.replace(/[=:]/g,function(a){return e[a]})}var cx=/\/+/g;function Wd(t,e){return typeof t=="object"&&t!==null&&t.key!=null?yb(""+t.key):e.toString(36)}function _b(t){switch(t.status){case"fulfilled":return t.value;case"rejected":throw t.reason;default:switch(typeof t.status=="string"?t.then(Xd,Xd):(t.status="pending",t.then(function(e){t.status==="pending"&&(t.status="fulfilled",t.value=e)},function(e){t.status==="pending"&&(t.status="rejected",t.reason=e)})),t.status){case"fulfilled":return t.value;case"rejected":throw t.reason}}throw t}function rr(t,e,a,n,i){var s=typeof t;(s==="undefined"||s==="boolean")&&(t=null);var r=!1;if(t===null)r=!0;else switch(s){case"bigint":case"string":case"number":r=!0;break;case"object":switch(t.$$typeof){case Yd:case ob:r=!0;break;case dx:return r=t._init,rr(r(t._payload),e,a,n,i)}}if(r)return i=i(t),r=n===""?"."+Wd(t,0):n,ux(i)?(a="",r!=null&&(a=r.replace(cx,"$&/")+"/"),rr(i,e,a,"",function(u){return u})):i!=null&&(Qd(i)&&(i=vb(i,a+(i.key==null||t&&t.key===i.key?"":(""+i.key).replace(cx,"$&/")+"/")+r)),e.push(i)),1;r=0;var o=n===""?".":n+":";if(ux(t))for(var l=0;l<t.length;l++)n=t[l],s=o+Wd(n,l),r+=rr(n,e,a,s,i);else if(l=xb(t),typeof l=="function")for(t=l.call(t),l=0;!(n=t.next()).done;)n=n.value,s=o+Wd(n,l++),r+=rr(n,e,a,s,i);else if(s==="object"){if(typeof t.then=="function")return rr(_b(t),e,a,n,i);throw e=String(t),Error("Objects are not valid as a React child (found: "+(e==="[object Object]"?"object with keys {"+Object.keys(t).join(", ")+"}":e)+"). If you meant to render a collection of children, use an array instead.")}return r}function fu(t,e,a){if(t==null)return t;var n=[],i=0;return rr(t,n,"","",function(s){return e.call(a,s,i++)}),n}function Sb(t){if(t._status===-1){var e=t._result;e=e(),e.then(function(a){(t._status===0||t._status===-1)&&(t._status=1,t._result=a)},function(a){(t._status===0||t._status===-1)&&(t._status=2,t._result=a)}),t._status===-1&&(t._status=0,t._result=e)}if(t._status===1)return t._result.default;throw t._result}var fx=typeof reportError=="function"?reportError:function(t){if(typeof window=="object"&&typeof window.ErrorEvent=="function"){var e=new window.ErrorEvent("error",{bubbles:!0,cancelable:!0,message:typeof t=="object"&&t!==null&&typeof t.message=="string"?String(t.message):String(t),error:t});if(!window.dispatchEvent(e))return}else if(typeof process=="object"&&typeof process.emit=="function"){process.emit("uncaughtException",t);return}console.error(t)},Mb={map:fu,forEach:function(t,e,a){fu(t,function(){e.apply(this,arguments)},a)},count:function(t){var e=0;return fu(t,function(){e++}),e},toArray:function(t){return fu(t,function(e){return e})||[]},only:function(t){if(!Qd(t))throw Error("React.Children.only expected to receive a single React element child.");return t}};Pe.Activity=gb;Pe.Children=Mb;Pe.Component=or;Pe.Fragment=lb;Pe.Profiler=cb;Pe.PureComponent=Zd;Pe.StrictMode=ub;Pe.Suspense=pb;Pe.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE=xt;Pe.__COMPILER_RUNTIME={__proto__:null,c:function(t){return xt.H.useMemoCache(t)}};Pe.cache=function(t){return function(){return t.apply(null,arguments)}};Pe.cacheSignal=function(){return null};Pe.cloneElement=function(t,e,a){if(t==null)throw Error("The argument must be a React element, but you passed "+t+".");var n=px({},t.props),i=t.key;if(e!=null)for(s in e.key!==void 0&&(i=""+e.key),e)!xx.call(e,s)||s==="key"||s==="__self"||s==="__source"||s==="ref"&&e.ref===void 0||(n[s]=e[s]);var s=arguments.length-2;if(s===1)n.children=a;else if(1<s){for(var r=Array(s),o=0;o<s;o++)r[o]=arguments[o+2];n.children=r}return Jd(t.type,i,n)};Pe.createContext=function(t){return t={$$typeof:db,_currentValue:t,_currentValue2:t,_threadCount:0,Provider:null,Consumer:null},t.Provider=t,t.Consumer={$$typeof:fb,_context:t},t};Pe.createElement=function(t,e,a){var n,i={},s=null;if(e!=null)for(n in e.key!==void 0&&(s=""+e.key),e)xx.call(e,n)&&n!=="key"&&n!=="__self"&&n!=="__source"&&(i[n]=e[n]);var r=arguments.length-2;if(r===1)i.children=a;else if(1<r){for(var o=Array(r),l=0;l<r;l++)o[l]=arguments[l+2];i.children=o}if(t&&t.defaultProps)for(n in r=t.defaultProps,r)i[n]===void 0&&(i[n]=r[n]);return Jd(t,s,i)};Pe.createRef=function(){return{current:null}};Pe.forwardRef=function(t){return{$$typeof:hb,render:t}};Pe.isValidElement=Qd;Pe.lazy=function(t){return{$$typeof:dx,_payload:{_status:-1,_result:t},_init:Sb}};Pe.memo=function(t,e){return{$$typeof:mb,type:t,compare:e===void 0?null:e}};Pe.startTransition=function(t){var e=xt.T,a={};xt.T=a;try{var n=t(),i=xt.S;i!==null&&i(a,n),typeof n=="object"&&n!==null&&typeof n.then=="function"&&n.then(Xd,fx)}catch(s){fx(s)}finally{e!==null&&a.types!==null&&(e.types=a.types),xt.T=e}};Pe.unstable_useCacheRefresh=function(){return xt.H.useCacheRefresh()};Pe.use=function(t){return xt.H.use(t)};Pe.useActionState=function(t,e,a){return xt.H.useActionState(t,e,a)};Pe.useCallback=function(t,e){return xt.H.useCallback(t,e)};Pe.useContext=function(t){return xt.H.useContext(t)};Pe.useDebugValue=function(){};Pe.useDeferredValue=function(t,e){return xt.H.useDeferredValue(t,e)};Pe.useEffect=function(t,e){return xt.H.useEffect(t,e)};Pe.useEffectEvent=function(t){return xt.H.useEffectEvent(t)};Pe.useId=function(){return xt.H.useId()};Pe.useImperativeHandle=function(t,e,a){return xt.H.useImperativeHandle(t,e,a)};Pe.useInsertionEffect=function(t,e){return xt.H.useInsertionEffect(t,e)};Pe.useLayoutEffect=function(t,e){return xt.H.useLayoutEffect(t,e)};Pe.useMemo=function(t,e){return xt.H.useMemo(t,e)};Pe.useOptimistic=function(t,e){return xt.H.useOptimistic(t,e)};Pe.useReducer=function(t,e,a){return xt.H.useReducer(t,e,a)};Pe.useRef=function(t){return xt.H.useRef(t)};Pe.useState=function(t){return xt.H.useState(t)};Pe.useSyncExternalStore=function(t,e,a){return xt.H.useSyncExternalStore(t,e,a)};Pe.useTransition=function(){return xt.H.useTransition()};Pe.version="19.2.8"});var Kn=In((Ow,yx)=>{"use strict";yx.exports=vx()});var rv=In(ff=>{"use strict";var KT=Symbol.for("react.transitional.element"),JT=Symbol.for("react.fragment");function sv(t,e,a){var n=null;if(a!==void 0&&(n=""+a),e.key!==void 0&&(n=""+e.key),"key"in e){a={};for(var i in e)i!=="key"&&(a[i]=e[i])}else a=e;return e=a.ref,{$$typeof:KT,type:t,key:n,ref:e!==void 0?e:null,props:a}}ff.Fragment=JT;ff.jsx=sv;ff.jsxs=sv});var Ns=In((JD,ov)=>{"use strict";ov.exports=rv()});var Cv=In(Ct=>{"use strict";function bp(t,e){var a=t.length;t.push(e);e:for(;0<a;){var n=a-1>>>1,i=t[n];if(0<pf(i,e))t[n]=e,t[a]=i,a=n;else break e}}function Hn(t){return t.length===0?null:t[0]}function gf(t){if(t.length===0)return null;var e=t[0],a=t.pop();if(a!==e){t[0]=a;e:for(var n=0,i=t.length,s=i>>>1;n<s;){var r=2*(n+1)-1,o=t[r],l=r+1,u=t[l];if(0>pf(o,a))l<i&&0>pf(u,o)?(t[n]=u,t[l]=a,n=l):(t[n]=o,t[r]=a,n=r);else if(l<i&&0>pf(u,a))t[n]=u,t[l]=a,n=l;else break e}}return e}function pf(t,e){var a=t.sortIndex-e.sortIndex;return a!==0?a:t.id-e.id}Ct.unstable_now=void 0;typeof performance=="object"&&typeof performance.now=="function"?(mv=performance,Ct.unstable_now=function(){return mv.now()}):(_p=Date,gv=_p.now(),Ct.unstable_now=function(){return _p.now()-gv});var mv,_p,gv,si=[],Zi=[],aI=1,an=null,ma=3,Cp=!1,ll=!1,ul=!1,Lp=!1,yv=typeof setTimeout=="function"?setTimeout:null,_v=typeof clearTimeout=="function"?clearTimeout:null,xv=typeof setImmediate<"u"?setImmediate:null;function mf(t){for(var e=Hn(Zi);e!==null;){if(e.callback===null)gf(Zi);else if(e.startTime<=t)gf(Zi),e.sortIndex=e.expirationTime,bp(si,e);else break;e=Hn(Zi)}}function Ap(t){if(ul=!1,mf(t),!ll)if(Hn(si)!==null)ll=!0,Ur||(Ur=!0,Pr());else{var e=Hn(Zi);e!==null&&Tp(Ap,e.startTime-t)}}var Ur=!1,cl=-1,Sv=5,Mv=-1;function bv(){return Lp?!0:!(Ct.unstable_now()-Mv<Sv)}function Sp(){if(Lp=!1,Ur){var t=Ct.unstable_now();Mv=t;var e=!0;try{e:{ll=!1,ul&&(ul=!1,_v(cl),cl=-1),Cp=!0;var a=ma;try{t:{for(mf(t),an=Hn(si);an!==null&&!(an.expirationTime>t&&bv());){var n=an.callback;if(typeof n=="function"){an.callback=null,ma=an.priorityLevel;var i=n(an.expirationTime<=t);if(t=Ct.unstable_now(),typeof i=="function"){an.callback=i,mf(t),e=!0;break t}an===Hn(si)&&gf(si),mf(t)}else gf(si);an=Hn(si)}if(an!==null)e=!0;else{var s=Hn(Zi);s!==null&&Tp(Ap,s.startTime-t),e=!1}}break e}finally{an=null,ma=a,Cp=!1}e=void 0}}finally{e?Pr():Ur=!1}}}var Pr;typeof xv=="function"?Pr=function(){xv(Sp)}:typeof MessageChannel<"u"?(Mp=new MessageChannel,vv=Mp.port2,Mp.port1.onmessage=Sp,Pr=function(){vv.postMessage(null)}):Pr=function(){yv(Sp,0)};var Mp,vv;function Tp(t,e){cl=yv(function(){t(Ct.unstable_now())},e)}Ct.unstable_IdlePriority=5;Ct.unstable_ImmediatePriority=1;Ct.unstable_LowPriority=4;Ct.unstable_NormalPriority=3;Ct.unstable_Profiling=null;Ct.unstable_UserBlockingPriority=2;Ct.unstable_cancelCallback=function(t){t.callback=null};Ct.unstable_forceFrameRate=function(t){0>t||125<t?console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"):Sv=0<t?Math.floor(1e3/t):5};Ct.unstable_getCurrentPriorityLevel=function(){return ma};Ct.unstable_next=function(t){switch(ma){case 1:case 2:case 3:var e=3;break;default:e=ma}var a=ma;ma=e;try{return t()}finally{ma=a}};Ct.unstable_requestPaint=function(){Lp=!0};Ct.unstable_runWithPriority=function(t,e){switch(t){case 1:case 2:case 3:case 4:case 5:break;default:t=3}var a=ma;ma=t;try{return e()}finally{ma=a}};Ct.unstable_scheduleCallback=function(t,e,a){var n=Ct.unstable_now();switch(typeof a=="object"&&a!==null?(a=a.delay,a=typeof a=="number"&&0<a?n+a:n):a=n,t){case 1:var i=-1;break;case 2:i=250;break;case 5:i=1073741823;break;case 4:i=1e4;break;default:i=5e3}return i=a+i,t={id:aI++,callback:e,priorityLevel:t,startTime:a,expirationTime:i,sortIndex:-1},a>n?(t.sortIndex=a,bp(Zi,t),Hn(si)===null&&t===Hn(Zi)&&(ul?(_v(cl),cl=-1):ul=!0,Tp(Ap,a-n))):(t.sortIndex=i,bp(si,t),ll||Cp||(ll=!0,Ur||(Ur=!0,Pr()))),t};Ct.unstable_shouldYield=bv;Ct.unstable_wrapCallback=function(t){var e=ma;return function(){var a=ma;ma=e;try{return t.apply(this,arguments)}finally{ma=a}}}});var Av=In((pP,Lv)=>{"use strict";Lv.exports=Cv()});var Iv=In(_a=>{"use strict";var nI=Kn();function Tv(t){var e="https://react.dev/errors/"+t;if(1<arguments.length){e+="?args[]="+encodeURIComponent(arguments[1]);for(var a=2;a<arguments.length;a++)e+="&args[]="+encodeURIComponent(arguments[a])}return"Minified React error #"+t+"; visit "+e+" for the full message or use the non-minified dev environment for full errors and additional helpful warnings."}function Ki(){}var ya={d:{f:Ki,r:function(){throw Error(Tv(522))},D:Ki,C:Ki,L:Ki,m:Ki,X:Ki,S:Ki,M:Ki},p:0,findDOMNode:null},iI=Symbol.for("react.portal");function sI(t,e,a){var n=3<arguments.length&&arguments[3]!==void 0?arguments[3]:null;return{$$typeof:iI,key:n==null?null:""+n,children:t,containerInfo:e,implementation:a}}var fl=nI.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;function xf(t,e){if(t==="font")return"";if(typeof e=="string")return e==="use-credentials"?e:""}_a.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE=ya;_a.createPortal=function(t,e){var a=2<arguments.length&&arguments[2]!==void 0?arguments[2]:null;if(!e||e.nodeType!==1&&e.nodeType!==9&&e.nodeType!==11)throw Error(Tv(299));return sI(t,e,null,a)};_a.flushSync=function(t){var e=fl.T,a=ya.p;try{if(fl.T=null,ya.p=2,t)return t()}finally{fl.T=e,ya.p=a,ya.d.f()}};_a.preconnect=function(t,e){typeof t=="string"&&(e?(e=e.crossOrigin,e=typeof e=="string"?e==="use-credentials"?e:"":void 0):e=null,ya.d.C(t,e))};_a.prefetchDNS=function(t){typeof t=="string"&&ya.d.D(t)};_a.preinit=function(t,e){if(typeof t=="string"&&e&&typeof e.as=="string"){var a=e.as,n=xf(a,e.crossOrigin),i=typeof e.integrity=="string"?e.integrity:void 0,s=typeof e.fetchPriority=="string"?e.fetchPriority:void 0;a==="style"?ya.d.S(t,typeof e.precedence=="string"?e.precedence:void 0,{crossOrigin:n,integrity:i,fetchPriority:s}):a==="script"&&ya.d.X(t,{crossOrigin:n,integrity:i,fetchPriority:s,nonce:typeof e.nonce=="string"?e.nonce:void 0})}};_a.preinitModule=function(t,e){if(typeof t=="string")if(typeof e=="object"&&e!==null){if(e.as==null||e.as==="script"){var a=xf(e.as,e.crossOrigin);ya.d.M(t,{crossOrigin:a,integrity:typeof e.integrity=="string"?e.integrity:void 0,nonce:typeof e.nonce=="string"?e.nonce:void 0})}}else e==null&&ya.d.M(t)};_a.preload=function(t,e){if(typeof t=="string"&&typeof e=="object"&&e!==null&&typeof e.as=="string"){var a=e.as,n=xf(a,e.crossOrigin);ya.d.L(t,a,{crossOrigin:n,integrity:typeof e.integrity=="string"?e.integrity:void 0,nonce:typeof e.nonce=="string"?e.nonce:void 0,type:typeof e.type=="string"?e.type:void 0,fetchPriority:typeof e.fetchPriority=="string"?e.fetchPriority:void 0,referrerPolicy:typeof e.referrerPolicy=="string"?e.referrerPolicy:void 0,imageSrcSet:typeof e.imageSrcSet=="string"?e.imageSrcSet:void 0,imageSizes:typeof e.imageSizes=="string"?e.imageSizes:void 0,media:typeof e.media=="string"?e.media:void 0})}};_a.preloadModule=function(t,e){if(typeof t=="string")if(e){var a=xf(e.as,e.crossOrigin);ya.d.m(t,{as:typeof e.as=="string"&&e.as!=="script"?e.as:void 0,crossOrigin:a,integrity:typeof e.integrity=="string"?e.integrity:void 0})}else ya.d.m(t)};_a.requestFormReset=function(t){ya.d.r(t)};_a.unstable_batchedUpdates=function(t,e){return t(e)};_a.useFormState=function(t,e,a){return fl.H.useFormState(t,e,a)};_a.useFormStatus=function(){return fl.H.useHostTransitionStatus()};_a.version="19.2.8"});var Rv=In((gP,wv)=>{"use strict";function Ev(){if(!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__>"u"||typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE!="function"))try{__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(Ev)}catch(t){console.error(t)}}Ev(),wv.exports=Iv()});var GM=In(Vd=>{"use strict";var Jt=Av(),n_=Kn(),rI=Rv();function Q(t){var e="https://react.dev/errors/"+t;if(1<arguments.length){e+="?args[]="+encodeURIComponent(arguments[1]);for(var a=2;a<arguments.length;a++)e+="&args[]="+encodeURIComponent(arguments[a])}return"Minified React error #"+t+"; visit "+e+" for the full message or use the non-minified dev environment for full errors and additional helpful warnings."}function i_(t){return!(!t||t.nodeType!==1&&t.nodeType!==9&&t.nodeType!==11)}function Ql(t){var e=t,a=t;if(t.alternate)for(;e.return;)e=e.return;else{t=e;do e=t,(e.flags&4098)!==0&&(a=e.return),t=e.return;while(t)}return e.tag===3?a:null}function s_(t){if(t.tag===13){var e=t.memoizedState;if(e===null&&(t=t.alternate,t!==null&&(e=t.memoizedState)),e!==null)return e.dehydrated}return null}function r_(t){if(t.tag===31){var e=t.memoizedState;if(e===null&&(t=t.alternate,t!==null&&(e=t.memoizedState)),e!==null)return e.dehydrated}return null}function Dv(t){if(Ql(t)!==t)throw Error(Q(188))}function oI(t){var e=t.alternate;if(!e){if(e=Ql(t),e===null)throw Error(Q(188));return e!==t?null:t}for(var a=t,n=e;;){var i=a.return;if(i===null)break;var s=i.alternate;if(s===null){if(n=i.return,n!==null){a=n;continue}break}if(i.child===s.child){for(s=i.child;s;){if(s===a)return Dv(i),t;if(s===n)return Dv(i),e;s=s.sibling}throw Error(Q(188))}if(a.return!==n.return)a=i,n=s;else{for(var r=!1,o=i.child;o;){if(o===a){r=!0,a=i,n=s;break}if(o===n){r=!0,n=i,a=s;break}o=o.sibling}if(!r){for(o=s.child;o;){if(o===a){r=!0,a=s,n=i;break}if(o===n){r=!0,n=s,a=i;break}o=o.sibling}if(!r)throw Error(Q(189))}}if(a.alternate!==n)throw Error(Q(190))}if(a.tag!==3)throw Error(Q(188));return a.stateNode.current===a?t:e}function o_(t){var e=t.tag;if(e===5||e===26||e===27||e===6)return t;for(t=t.child;t!==null;){if(e=o_(t),e!==null)return e;t=t.sibling}return null}var Mt=Object.assign,lI=Symbol.for("react.element"),vf=Symbol.for("react.transitional.element"),yl=Symbol.for("react.portal"),kr=Symbol.for("react.fragment"),l_=Symbol.for("react.strict_mode"),om=Symbol.for("react.profiler"),u_=Symbol.for("react.consumer"),hi=Symbol.for("react.context"),ag=Symbol.for("react.forward_ref"),lm=Symbol.for("react.suspense"),um=Symbol.for("react.suspense_list"),ng=Symbol.for("react.memo"),Ji=Symbol.for("react.lazy"),cm=Symbol.for("react.activity"),uI=Symbol.for("react.memo_cache_sentinel"),Pv=Symbol.iterator;function dl(t){return t===null||typeof t!="object"?null:(t=Pv&&t[Pv]||t["@@iterator"],typeof t=="function"?t:null)}var cI=Symbol.for("react.client.reference");function fm(t){if(t==null)return null;if(typeof t=="function")return t.$$typeof===cI?null:t.displayName||t.name||null;if(typeof t=="string")return t;switch(t){case kr:return"Fragment";case om:return"Profiler";case l_:return"StrictMode";case lm:return"Suspense";case um:return"SuspenseList";case cm:return"Activity"}if(typeof t=="object")switch(t.$$typeof){case yl:return"Portal";case hi:return t.displayName||"Context";case u_:return(t._context.displayName||"Context")+".Consumer";case ag:var e=t.render;return t=t.displayName,t||(t=e.displayName||e.name||"",t=t!==""?"ForwardRef("+t+")":"ForwardRef"),t;case ng:return e=t.displayName||null,e!==null?e:fm(t.type)||"Memo";case Ji:e=t._payload,t=t._init;try{return fm(t(e))}catch{}}return null}var _l=Array.isArray,we=n_.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,tt=rI.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,Gs={pending:!1,data:null,method:null,action:null},dm=[],Hr=-1;function Xn(t){return{current:t}}function aa(t){0>Hr||(t.current=dm[Hr],dm[Hr]=null,Hr--)}function gt(t,e){Hr++,dm[Hr]=t.current,t.current=e}var Wn=Xn(null),Nl=Xn(null),os=Xn(null),Qf=Xn(null);function jf(t,e){switch(gt(os,e),gt(Nl,t),gt(Wn,null),e.nodeType){case 9:case 11:t=(t=e.documentElement)&&(t=t.namespaceURI)?ky(t):0;break;default:if(t=e.tagName,e=e.namespaceURI)e=ky(e),t=EM(e,t);else switch(t){case"svg":t=1;break;case"math":t=2;break;default:t=0}}aa(Wn),gt(Wn,t)}function so(){aa(Wn),aa(Nl),aa(os)}function hm(t){t.memoizedState!==null&&gt(Qf,t);var e=Wn.current,a=EM(e,t.type);e!==a&&(gt(Nl,t),gt(Wn,a))}function $f(t){Nl.current===t&&(aa(Wn),aa(Nl)),Qf.current===t&&(aa(Qf),Zl._currentValue=Gs)}var Ip,Uv;function zs(t){if(Ip===void 0)try{throw Error()}catch(a){var e=a.stack.trim().match(/\n( *(at )?)/);Ip=e&&e[1]||"",Uv=-1<a.stack.indexOf(`
    at`)?" (<anonymous>)":-1<a.stack.indexOf("@")?"@unknown:0:0":""}return`
`+Ip+t+Uv}var Ep=!1;function wp(t,e){if(!t||Ep)return"";Ep=!0;var a=Error.prepareStackTrace;Error.prepareStackTrace=void 0;try{var n={DetermineComponentFrameRoot:function(){try{if(e){var p=function(){throw Error()};if(Object.defineProperty(p.prototype,"props",{set:function(){throw Error()}}),typeof Reflect=="object"&&Reflect.construct){try{Reflect.construct(p,[])}catch(h){var c=h}Reflect.construct(t,[],p)}else{try{p.call()}catch(h){c=h}t.call(p.prototype)}}else{try{throw Error()}catch(h){c=h}(p=t())&&typeof p.catch=="function"&&p.catch(function(){})}}catch(h){if(h&&c&&typeof h.stack=="string")return[h.stack,c.stack]}return[null,null]}};n.DetermineComponentFrameRoot.displayName="DetermineComponentFrameRoot";var i=Object.getOwnPropertyDescriptor(n.DetermineComponentFrameRoot,"name");i&&i.configurable&&Object.defineProperty(n.DetermineComponentFrameRoot,"name",{value:"DetermineComponentFrameRoot"});var s=n.DetermineComponentFrameRoot(),r=s[0],o=s[1];if(r&&o){var l=r.split(`
`),u=o.split(`
`);for(i=n=0;n<l.length&&!l[n].includes("DetermineComponentFrameRoot");)n++;for(;i<u.length&&!u[i].includes("DetermineComponentFrameRoot");)i++;if(n===l.length||i===u.length)for(n=l.length-1,i=u.length-1;1<=n&&0<=i&&l[n]!==u[i];)i--;for(;1<=n&&0<=i;n--,i--)if(l[n]!==u[i]){if(n!==1||i!==1)do if(n--,i--,0>i||l[n]!==u[i]){var d=`
`+l[n].replace(" at new "," at ");return t.displayName&&d.includes("<anonymous>")&&(d=d.replace("<anonymous>",t.displayName)),d}while(1<=n&&0<=i);break}}}finally{Ep=!1,Error.prepareStackTrace=a}return(a=t?t.displayName||t.name:"")?zs(a):""}function fI(t,e){switch(t.tag){case 26:case 27:case 5:return zs(t.type);case 16:return zs("Lazy");case 13:return t.child!==e&&e!==null?zs("Suspense Fallback"):zs("Suspense");case 19:return zs("SuspenseList");case 0:case 15:return wp(t.type,!1);case 11:return wp(t.type.render,!1);case 1:return wp(t.type,!0);case 31:return zs("Activity");default:return""}}function Bv(t){try{var e="",a=null;do e+=fI(t,a),a=t,t=t.return;while(t);return e}catch(n){return`
Error generating stack: `+n.message+`
`+n.stack}}var pm=Object.prototype.hasOwnProperty,ig=Jt.unstable_scheduleCallback,Rp=Jt.unstable_cancelCallback,dI=Jt.unstable_shouldYield,hI=Jt.unstable_requestPaint,Wa=Jt.unstable_now,pI=Jt.unstable_getCurrentPriorityLevel,c_=Jt.unstable_ImmediatePriority,f_=Jt.unstable_UserBlockingPriority,ed=Jt.unstable_NormalPriority,mI=Jt.unstable_LowPriority,d_=Jt.unstable_IdlePriority,gI=Jt.log,xI=Jt.unstable_setDisableYieldValue,jl=null,Xa=null;function as(t){if(typeof gI=="function"&&xI(t),Xa&&typeof Xa.setStrictMode=="function")try{Xa.setStrictMode(jl,t)}catch{}}var Ya=Math.clz32?Math.clz32:_I,vI=Math.log,yI=Math.LN2;function _I(t){return t>>>=0,t===0?32:31-(vI(t)/yI|0)|0}var yf=256,_f=262144,Sf=4194304;function ks(t){var e=t&42;if(e!==0)return e;switch(t&-t){case 1:return 1;case 2:return 2;case 4:return 4;case 8:return 8;case 16:return 16;case 32:return 32;case 64:return 64;case 128:return 128;case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:return t&261888;case 262144:case 524288:case 1048576:case 2097152:return t&3932160;case 4194304:case 8388608:case 16777216:case 33554432:return t&62914560;case 67108864:return 67108864;case 134217728:return 134217728;case 268435456:return 268435456;case 536870912:return 536870912;case 1073741824:return 0;default:return t}}function Ad(t,e,a){var n=t.pendingLanes;if(n===0)return 0;var i=0,s=t.suspendedLanes,r=t.pingedLanes;t=t.warmLanes;var o=n&134217727;return o!==0?(n=o&~s,n!==0?i=ks(n):(r&=o,r!==0?i=ks(r):a||(a=o&~t,a!==0&&(i=ks(a))))):(o=n&~s,o!==0?i=ks(o):r!==0?i=ks(r):a||(a=n&~t,a!==0&&(i=ks(a)))),i===0?0:e!==0&&e!==i&&(e&s)===0&&(s=i&-i,a=e&-e,s>=a||s===32&&(a&4194048)!==0)?e:i}function $l(t,e){return(t.pendingLanes&~(t.suspendedLanes&~t.pingedLanes)&e)===0}function SI(t,e){switch(t){case 1:case 2:case 4:case 8:case 64:return e+250;case 16:case 32:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return e+5e3;case 4194304:case 8388608:case 16777216:case 33554432:return-1;case 67108864:case 134217728:case 268435456:case 536870912:case 1073741824:return-1;default:return-1}}function h_(){var t=Sf;return Sf<<=1,(Sf&62914560)===0&&(Sf=4194304),t}function Dp(t){for(var e=[],a=0;31>a;a++)e.push(t);return e}function eu(t,e){t.pendingLanes|=e,e!==268435456&&(t.suspendedLanes=0,t.pingedLanes=0,t.warmLanes=0)}function MI(t,e,a,n,i,s){var r=t.pendingLanes;t.pendingLanes=a,t.suspendedLanes=0,t.pingedLanes=0,t.warmLanes=0,t.expiredLanes&=a,t.entangledLanes&=a,t.errorRecoveryDisabledLanes&=a,t.shellSuspendCounter=0;var o=t.entanglements,l=t.expirationTimes,u=t.hiddenUpdates;for(a=r&~a;0<a;){var d=31-Ya(a),p=1<<d;o[d]=0,l[d]=-1;var c=u[d];if(c!==null)for(u[d]=null,d=0;d<c.length;d++){var h=c[d];h!==null&&(h.lane&=-536870913)}a&=~p}n!==0&&p_(t,n,0),s!==0&&i===0&&t.tag!==0&&(t.suspendedLanes|=s&~(r&~e))}function p_(t,e,a){t.pendingLanes|=e,t.suspendedLanes&=~e;var n=31-Ya(e);t.entangledLanes|=e,t.entanglements[n]=t.entanglements[n]|1073741824|a&261930}function m_(t,e){var a=t.entangledLanes|=e;for(t=t.entanglements;a;){var n=31-Ya(a),i=1<<n;i&e|t[n]&e&&(t[n]|=e),a&=~i}}function g_(t,e){var a=e&-e;return a=(a&42)!==0?1:sg(a),(a&(t.suspendedLanes|e))!==0?0:a}function sg(t){switch(t){case 2:t=1;break;case 8:t=4;break;case 32:t=16;break;case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:case 4194304:case 8388608:case 16777216:case 33554432:t=128;break;case 268435456:t=134217728;break;default:t=0}return t}function rg(t){return t&=-t,2<t?8<t?(t&134217727)!==0?32:268435456:8:2}function x_(){var t=tt.p;return t!==0?t:(t=window.event,t===void 0?32:kM(t.type))}function Ov(t,e){var a=tt.p;try{return tt.p=t,e()}finally{tt.p=a}}var _s=Math.random().toString(36).slice(2),ra="__reactFiber$"+_s,Ra="__reactProps$"+_s,xo="__reactContainer$"+_s,mm="__reactEvents$"+_s,bI="__reactListeners$"+_s,CI="__reactHandles$"+_s,Nv="__reactResources$"+_s,tu="__reactMarker$"+_s;function og(t){delete t[ra],delete t[Ra],delete t[mm],delete t[bI],delete t[CI]}function Vr(t){var e=t[ra];if(e)return e;for(var a=t.parentNode;a;){if(e=a[xo]||a[ra]){if(a=e.alternate,e.child!==null||a!==null&&a.child!==null)for(t=Wy(t);t!==null;){if(a=t[ra])return a;t=Wy(t)}return e}t=a,a=t.parentNode}return null}function vo(t){if(t=t[ra]||t[xo]){var e=t.tag;if(e===5||e===6||e===13||e===31||e===26||e===27||e===3)return t}return null}function Sl(t){var e=t.tag;if(e===5||e===26||e===27||e===6)return t.stateNode;throw Error(Q(33))}function jr(t){var e=t[Nv];return e||(e=t[Nv]={hoistableStyles:new Map,hoistableScripts:new Map}),e}function ta(t){t[tu]=!0}var v_=new Set,y_={};function $s(t,e){ro(t,e),ro(t+"Capture",e)}function ro(t,e){for(y_[t]=e,t=0;t<e.length;t++)v_.add(e[t])}var LI=RegExp("^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$"),Fv={},zv={};function AI(t){return pm.call(zv,t)?!0:pm.call(Fv,t)?!1:LI.test(t)?zv[t]=!0:(Fv[t]=!0,!1)}function Of(t,e,a){if(AI(e))if(a===null)t.removeAttribute(e);else{switch(typeof a){case"undefined":case"function":case"symbol":t.removeAttribute(e);return;case"boolean":var n=e.toLowerCase().slice(0,5);if(n!=="data-"&&n!=="aria-"){t.removeAttribute(e);return}}t.setAttribute(e,""+a)}}function Mf(t,e,a){if(a===null)t.removeAttribute(e);else{switch(typeof a){case"undefined":case"function":case"symbol":case"boolean":t.removeAttribute(e);return}t.setAttribute(e,""+a)}}function ri(t,e,a,n){if(n===null)t.removeAttribute(a);else{switch(typeof n){case"undefined":case"function":case"symbol":case"boolean":t.removeAttribute(a);return}t.setAttributeNS(e,a,""+n)}}function sn(t){switch(typeof t){case"bigint":case"boolean":case"number":case"string":case"undefined":return t;case"object":return t;default:return""}}function __(t){var e=t.type;return(t=t.nodeName)&&t.toLowerCase()==="input"&&(e==="checkbox"||e==="radio")}function TI(t,e,a){var n=Object.getOwnPropertyDescriptor(t.constructor.prototype,e);if(!t.hasOwnProperty(e)&&typeof n<"u"&&typeof n.get=="function"&&typeof n.set=="function"){var i=n.get,s=n.set;return Object.defineProperty(t,e,{configurable:!0,get:function(){return i.call(this)},set:function(r){a=""+r,s.call(this,r)}}),Object.defineProperty(t,e,{enumerable:n.enumerable}),{getValue:function(){return a},setValue:function(r){a=""+r},stopTracking:function(){t._valueTracker=null,delete t[e]}}}}function gm(t){if(!t._valueTracker){var e=__(t)?"checked":"value";t._valueTracker=TI(t,e,""+t[e])}}function S_(t){if(!t)return!1;var e=t._valueTracker;if(!e)return!0;var a=e.getValue(),n="";return t&&(n=__(t)?t.checked?"true":"false":t.value),t=n,t!==a?(e.setValue(t),!0):!1}function td(t){if(t=t||(typeof document<"u"?document:void 0),typeof t>"u")return null;try{return t.activeElement||t.body}catch{return t.body}}var II=/[\n"\\]/g;function ln(t){return t.replace(II,function(e){return"\\"+e.charCodeAt(0).toString(16)+" "})}function xm(t,e,a,n,i,s,r,o){t.name="",r!=null&&typeof r!="function"&&typeof r!="symbol"&&typeof r!="boolean"?t.type=r:t.removeAttribute("type"),e!=null?r==="number"?(e===0&&t.value===""||t.value!=e)&&(t.value=""+sn(e)):t.value!==""+sn(e)&&(t.value=""+sn(e)):r!=="submit"&&r!=="reset"||t.removeAttribute("value"),e!=null?vm(t,r,sn(e)):a!=null?vm(t,r,sn(a)):n!=null&&t.removeAttribute("value"),i==null&&s!=null&&(t.defaultChecked=!!s),i!=null&&(t.checked=i&&typeof i!="function"&&typeof i!="symbol"),o!=null&&typeof o!="function"&&typeof o!="symbol"&&typeof o!="boolean"?t.name=""+sn(o):t.removeAttribute("name")}function M_(t,e,a,n,i,s,r,o){if(s!=null&&typeof s!="function"&&typeof s!="symbol"&&typeof s!="boolean"&&(t.type=s),e!=null||a!=null){if(!(s!=="submit"&&s!=="reset"||e!=null)){gm(t);return}a=a!=null?""+sn(a):"",e=e!=null?""+sn(e):a,o||e===t.value||(t.value=e),t.defaultValue=e}n=n??i,n=typeof n!="function"&&typeof n!="symbol"&&!!n,t.checked=o?t.checked:!!n,t.defaultChecked=!!n,r!=null&&typeof r!="function"&&typeof r!="symbol"&&typeof r!="boolean"&&(t.name=r),gm(t)}function vm(t,e,a){e==="number"&&td(t.ownerDocument)===t||t.defaultValue===""+a||(t.defaultValue=""+a)}function $r(t,e,a,n){if(t=t.options,e){e={};for(var i=0;i<a.length;i++)e["$"+a[i]]=!0;for(a=0;a<t.length;a++)i=e.hasOwnProperty("$"+t[a].value),t[a].selected!==i&&(t[a].selected=i),i&&n&&(t[a].defaultSelected=!0)}else{for(a=""+sn(a),e=null,i=0;i<t.length;i++){if(t[i].value===a){t[i].selected=!0,n&&(t[i].defaultSelected=!0);return}e!==null||t[i].disabled||(e=t[i])}e!==null&&(e.selected=!0)}}function b_(t,e,a){if(e!=null&&(e=""+sn(e),e!==t.value&&(t.value=e),a==null)){t.defaultValue!==e&&(t.defaultValue=e);return}t.defaultValue=a!=null?""+sn(a):""}function C_(t,e,a,n){if(e==null){if(n!=null){if(a!=null)throw Error(Q(92));if(_l(n)){if(1<n.length)throw Error(Q(93));n=n[0]}a=n}a==null&&(a=""),e=a}a=sn(e),t.defaultValue=a,n=t.textContent,n===a&&n!==""&&n!==null&&(t.value=n),gm(t)}function oo(t,e){if(e){var a=t.firstChild;if(a&&a===t.lastChild&&a.nodeType===3){a.nodeValue=e;return}}t.textContent=e}var EI=new Set("animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(" "));function kv(t,e,a){var n=e.indexOf("--")===0;a==null||typeof a=="boolean"||a===""?n?t.setProperty(e,""):e==="float"?t.cssFloat="":t[e]="":n?t.setProperty(e,a):typeof a!="number"||a===0||EI.has(e)?e==="float"?t.cssFloat=a:t[e]=(""+a).trim():t[e]=a+"px"}function L_(t,e,a){if(e!=null&&typeof e!="object")throw Error(Q(62));if(t=t.style,a!=null){for(var n in a)!a.hasOwnProperty(n)||e!=null&&e.hasOwnProperty(n)||(n.indexOf("--")===0?t.setProperty(n,""):n==="float"?t.cssFloat="":t[n]="");for(var i in e)n=e[i],e.hasOwnProperty(i)&&a[i]!==n&&kv(t,i,n)}else for(var s in e)e.hasOwnProperty(s)&&kv(t,s,e[s])}function lg(t){if(t.indexOf("-")===-1)return!1;switch(t){case"annotation-xml":case"color-profile":case"font-face":case"font-face-src":case"font-face-uri":case"font-face-format":case"font-face-name":case"missing-glyph":return!1;default:return!0}}var wI=new Map([["acceptCharset","accept-charset"],["htmlFor","for"],["httpEquiv","http-equiv"],["crossOrigin","crossorigin"],["accentHeight","accent-height"],["alignmentBaseline","alignment-baseline"],["arabicForm","arabic-form"],["baselineShift","baseline-shift"],["capHeight","cap-height"],["clipPath","clip-path"],["clipRule","clip-rule"],["colorInterpolation","color-interpolation"],["colorInterpolationFilters","color-interpolation-filters"],["colorProfile","color-profile"],["colorRendering","color-rendering"],["dominantBaseline","dominant-baseline"],["enableBackground","enable-background"],["fillOpacity","fill-opacity"],["fillRule","fill-rule"],["floodColor","flood-color"],["floodOpacity","flood-opacity"],["fontFamily","font-family"],["fontSize","font-size"],["fontSizeAdjust","font-size-adjust"],["fontStretch","font-stretch"],["fontStyle","font-style"],["fontVariant","font-variant"],["fontWeight","font-weight"],["glyphName","glyph-name"],["glyphOrientationHorizontal","glyph-orientation-horizontal"],["glyphOrientationVertical","glyph-orientation-vertical"],["horizAdvX","horiz-adv-x"],["horizOriginX","horiz-origin-x"],["imageRendering","image-rendering"],["letterSpacing","letter-spacing"],["lightingColor","lighting-color"],["markerEnd","marker-end"],["markerMid","marker-mid"],["markerStart","marker-start"],["overlinePosition","overline-position"],["overlineThickness","overline-thickness"],["paintOrder","paint-order"],["panose-1","panose-1"],["pointerEvents","pointer-events"],["renderingIntent","rendering-intent"],["shapeRendering","shape-rendering"],["stopColor","stop-color"],["stopOpacity","stop-opacity"],["strikethroughPosition","strikethrough-position"],["strikethroughThickness","strikethrough-thickness"],["strokeDasharray","stroke-dasharray"],["strokeDashoffset","stroke-dashoffset"],["strokeLinecap","stroke-linecap"],["strokeLinejoin","stroke-linejoin"],["strokeMiterlimit","stroke-miterlimit"],["strokeOpacity","stroke-opacity"],["strokeWidth","stroke-width"],["textAnchor","text-anchor"],["textDecoration","text-decoration"],["textRendering","text-rendering"],["transformOrigin","transform-origin"],["underlinePosition","underline-position"],["underlineThickness","underline-thickness"],["unicodeBidi","unicode-bidi"],["unicodeRange","unicode-range"],["unitsPerEm","units-per-em"],["vAlphabetic","v-alphabetic"],["vHanging","v-hanging"],["vIdeographic","v-ideographic"],["vMathematical","v-mathematical"],["vectorEffect","vector-effect"],["vertAdvY","vert-adv-y"],["vertOriginX","vert-origin-x"],["vertOriginY","vert-origin-y"],["wordSpacing","word-spacing"],["writingMode","writing-mode"],["xmlnsXlink","xmlns:xlink"],["xHeight","x-height"]]),RI=/^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;function Nf(t){return RI.test(""+t)?"javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')":t}function pi(){}var ym=null;function ug(t){return t=t.target||t.srcElement||window,t.correspondingUseElement&&(t=t.correspondingUseElement),t.nodeType===3?t.parentNode:t}var Gr=null,eo=null;function Hv(t){var e=vo(t);if(e&&(t=e.stateNode)){var a=t[Ra]||null;e:switch(t=e.stateNode,e.type){case"input":if(xm(t,a.value,a.defaultValue,a.defaultValue,a.checked,a.defaultChecked,a.type,a.name),e=a.name,a.type==="radio"&&e!=null){for(a=t;a.parentNode;)a=a.parentNode;for(a=a.querySelectorAll('input[name="'+ln(""+e)+'"][type="radio"]'),e=0;e<a.length;e++){var n=a[e];if(n!==t&&n.form===t.form){var i=n[Ra]||null;if(!i)throw Error(Q(90));xm(n,i.value,i.defaultValue,i.defaultValue,i.checked,i.defaultChecked,i.type,i.name)}}for(e=0;e<a.length;e++)n=a[e],n.form===t.form&&S_(n)}break e;case"textarea":b_(t,a.value,a.defaultValue);break e;case"select":e=a.value,e!=null&&$r(t,!!a.multiple,e,!1)}}}var Pp=!1;function A_(t,e,a){if(Pp)return t(e,a);Pp=!0;try{var n=t(e);return n}finally{if(Pp=!1,(Gr!==null||eo!==null)&&(Fd(),Gr&&(e=Gr,t=eo,eo=Gr=null,Hv(e),t)))for(e=0;e<t.length;e++)Hv(t[e])}}function Fl(t,e){var a=t.stateNode;if(a===null)return null;var n=a[Ra]||null;if(n===null)return null;a=n[e];e:switch(e){case"onClick":case"onClickCapture":case"onDoubleClick":case"onDoubleClickCapture":case"onMouseDown":case"onMouseDownCapture":case"onMouseMove":case"onMouseMoveCapture":case"onMouseUp":case"onMouseUpCapture":case"onMouseEnter":(n=!n.disabled)||(t=t.type,n=!(t==="button"||t==="input"||t==="select"||t==="textarea")),t=!n;break e;default:t=!1}if(t)return null;if(a&&typeof a!="function")throw Error(Q(231,e,typeof a));return a}var yi=!(typeof window>"u"||typeof window.document>"u"||typeof window.document.createElement>"u"),_m=!1;if(yi)try{Br={},Object.defineProperty(Br,"passive",{get:function(){_m=!0}}),window.addEventListener("test",Br,Br),window.removeEventListener("test",Br,Br)}catch{_m=!1}var Br,ns=null,cg=null,Ff=null;function T_(){if(Ff)return Ff;var t,e=cg,a=e.length,n,i="value"in ns?ns.value:ns.textContent,s=i.length;for(t=0;t<a&&e[t]===i[t];t++);var r=a-t;for(n=1;n<=r&&e[a-n]===i[s-n];n++);return Ff=i.slice(t,1<n?1-n:void 0)}function zf(t){var e=t.keyCode;return"charCode"in t?(t=t.charCode,t===0&&e===13&&(t=13)):t=e,t===10&&(t=13),32<=t||t===13?t:0}function bf(){return!0}function Vv(){return!1}function Da(t){function e(a,n,i,s,r){this._reactName=a,this._targetInst=i,this.type=n,this.nativeEvent=s,this.target=r,this.currentTarget=null;for(var o in t)t.hasOwnProperty(o)&&(a=t[o],this[o]=a?a(s):s[o]);return this.isDefaultPrevented=(s.defaultPrevented!=null?s.defaultPrevented:s.returnValue===!1)?bf:Vv,this.isPropagationStopped=Vv,this}return Mt(e.prototype,{preventDefault:function(){this.defaultPrevented=!0;var a=this.nativeEvent;a&&(a.preventDefault?a.preventDefault():typeof a.returnValue!="unknown"&&(a.returnValue=!1),this.isDefaultPrevented=bf)},stopPropagation:function(){var a=this.nativeEvent;a&&(a.stopPropagation?a.stopPropagation():typeof a.cancelBubble!="unknown"&&(a.cancelBubble=!0),this.isPropagationStopped=bf)},persist:function(){},isPersistent:bf}),e}var er={eventPhase:0,bubbles:0,cancelable:0,timeStamp:function(t){return t.timeStamp||Date.now()},defaultPrevented:0,isTrusted:0},Td=Da(er),au=Mt({},er,{view:0,detail:0}),DI=Da(au),Up,Bp,hl,Id=Mt({},au,{screenX:0,screenY:0,clientX:0,clientY:0,pageX:0,pageY:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,getModifierState:fg,button:0,buttons:0,relatedTarget:function(t){return t.relatedTarget===void 0?t.fromElement===t.srcElement?t.toElement:t.fromElement:t.relatedTarget},movementX:function(t){return"movementX"in t?t.movementX:(t!==hl&&(hl&&t.type==="mousemove"?(Up=t.screenX-hl.screenX,Bp=t.screenY-hl.screenY):Bp=Up=0,hl=t),Up)},movementY:function(t){return"movementY"in t?t.movementY:Bp}}),Gv=Da(Id),PI=Mt({},Id,{dataTransfer:0}),UI=Da(PI),BI=Mt({},au,{relatedTarget:0}),Op=Da(BI),OI=Mt({},er,{animationName:0,elapsedTime:0,pseudoElement:0}),NI=Da(OI),FI=Mt({},er,{clipboardData:function(t){return"clipboardData"in t?t.clipboardData:window.clipboardData}}),zI=Da(FI),kI=Mt({},er,{data:0}),qv=Da(kI),HI={Esc:"Escape",Spacebar:" ",Left:"ArrowLeft",Up:"ArrowUp",Right:"ArrowRight",Down:"ArrowDown",Del:"Delete",Win:"OS",Menu:"ContextMenu",Apps:"ContextMenu",Scroll:"ScrollLock",MozPrintableKey:"Unidentified"},VI={8:"Backspace",9:"Tab",12:"Clear",13:"Enter",16:"Shift",17:"Control",18:"Alt",19:"Pause",20:"CapsLock",27:"Escape",32:" ",33:"PageUp",34:"PageDown",35:"End",36:"Home",37:"ArrowLeft",38:"ArrowUp",39:"ArrowRight",40:"ArrowDown",45:"Insert",46:"Delete",112:"F1",113:"F2",114:"F3",115:"F4",116:"F5",117:"F6",118:"F7",119:"F8",120:"F9",121:"F10",122:"F11",123:"F12",144:"NumLock",145:"ScrollLock",224:"Meta"},GI={Alt:"altKey",Control:"ctrlKey",Meta:"metaKey",Shift:"shiftKey"};function qI(t){var e=this.nativeEvent;return e.getModifierState?e.getModifierState(t):(t=GI[t])?!!e[t]:!1}function fg(){return qI}var WI=Mt({},au,{key:function(t){if(t.key){var e=HI[t.key]||t.key;if(e!=="Unidentified")return e}return t.type==="keypress"?(t=zf(t),t===13?"Enter":String.fromCharCode(t)):t.type==="keydown"||t.type==="keyup"?VI[t.keyCode]||"Unidentified":""},code:0,location:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,repeat:0,locale:0,getModifierState:fg,charCode:function(t){return t.type==="keypress"?zf(t):0},keyCode:function(t){return t.type==="keydown"||t.type==="keyup"?t.keyCode:0},which:function(t){return t.type==="keypress"?zf(t):t.type==="keydown"||t.type==="keyup"?t.keyCode:0}}),XI=Da(WI),YI=Mt({},Id,{pointerId:0,width:0,height:0,pressure:0,tangentialPressure:0,tiltX:0,tiltY:0,twist:0,pointerType:0,isPrimary:0}),Wv=Da(YI),ZI=Mt({},au,{touches:0,targetTouches:0,changedTouches:0,altKey:0,metaKey:0,ctrlKey:0,shiftKey:0,getModifierState:fg}),KI=Da(ZI),JI=Mt({},er,{propertyName:0,elapsedTime:0,pseudoElement:0}),QI=Da(JI),jI=Mt({},Id,{deltaX:function(t){return"deltaX"in t?t.deltaX:"wheelDeltaX"in t?-t.wheelDeltaX:0},deltaY:function(t){return"deltaY"in t?t.deltaY:"wheelDeltaY"in t?-t.wheelDeltaY:"wheelDelta"in t?-t.wheelDelta:0},deltaZ:0,deltaMode:0}),$I=Da(jI),eE=Mt({},er,{newState:0,oldState:0}),tE=Da(eE),aE=[9,13,27,32],dg=yi&&"CompositionEvent"in window,Cl=null;yi&&"documentMode"in document&&(Cl=document.documentMode);var nE=yi&&"TextEvent"in window&&!Cl,I_=yi&&(!dg||Cl&&8<Cl&&11>=Cl),Xv=" ",Yv=!1;function E_(t,e){switch(t){case"keyup":return aE.indexOf(e.keyCode)!==-1;case"keydown":return e.keyCode!==229;case"keypress":case"mousedown":case"focusout":return!0;default:return!1}}function w_(t){return t=t.detail,typeof t=="object"&&"data"in t?t.data:null}var qr=!1;function iE(t,e){switch(t){case"compositionend":return w_(e);case"keypress":return e.which!==32?null:(Yv=!0,Xv);case"textInput":return t=e.data,t===Xv&&Yv?null:t;default:return null}}function sE(t,e){if(qr)return t==="compositionend"||!dg&&E_(t,e)?(t=T_(),Ff=cg=ns=null,qr=!1,t):null;switch(t){case"paste":return null;case"keypress":if(!(e.ctrlKey||e.altKey||e.metaKey)||e.ctrlKey&&e.altKey){if(e.char&&1<e.char.length)return e.char;if(e.which)return String.fromCharCode(e.which)}return null;case"compositionend":return I_&&e.locale!=="ko"?null:e.data;default:return null}}var rE={color:!0,date:!0,datetime:!0,"datetime-local":!0,email:!0,month:!0,number:!0,password:!0,range:!0,search:!0,tel:!0,text:!0,time:!0,url:!0,week:!0};function Zv(t){var e=t&&t.nodeName&&t.nodeName.toLowerCase();return e==="input"?!!rE[t.type]:e==="textarea"}function R_(t,e,a,n){Gr?eo?eo.push(n):eo=[n]:Gr=n,e=yd(e,"onChange"),0<e.length&&(a=new Td("onChange","change",null,a,n),t.push({event:a,listeners:e}))}var Ll=null,zl=null;function oE(t){AM(t,0)}function Ed(t){var e=Sl(t);if(S_(e))return t}function Kv(t,e){if(t==="change")return e}var D_=!1;yi&&(yi?(Lf="oninput"in document,Lf||(Np=document.createElement("div"),Np.setAttribute("oninput","return;"),Lf=typeof Np.oninput=="function"),Cf=Lf):Cf=!1,D_=Cf&&(!document.documentMode||9<document.documentMode));var Cf,Lf,Np;function Jv(){Ll&&(Ll.detachEvent("onpropertychange",P_),zl=Ll=null)}function P_(t){if(t.propertyName==="value"&&Ed(zl)){var e=[];R_(e,zl,t,ug(t)),A_(oE,e)}}function lE(t,e,a){t==="focusin"?(Jv(),Ll=e,zl=a,Ll.attachEvent("onpropertychange",P_)):t==="focusout"&&Jv()}function uE(t){if(t==="selectionchange"||t==="keyup"||t==="keydown")return Ed(zl)}function cE(t,e){if(t==="click")return Ed(e)}function fE(t,e){if(t==="input"||t==="change")return Ed(e)}function dE(t,e){return t===e&&(t!==0||1/t===1/e)||t!==t&&e!==e}var Ka=typeof Object.is=="function"?Object.is:dE;function kl(t,e){if(Ka(t,e))return!0;if(typeof t!="object"||t===null||typeof e!="object"||e===null)return!1;var a=Object.keys(t),n=Object.keys(e);if(a.length!==n.length)return!1;for(n=0;n<a.length;n++){var i=a[n];if(!pm.call(e,i)||!Ka(t[i],e[i]))return!1}return!0}function Qv(t){for(;t&&t.firstChild;)t=t.firstChild;return t}function jv(t,e){var a=Qv(t);t=0;for(var n;a;){if(a.nodeType===3){if(n=t+a.textContent.length,t<=e&&n>=e)return{node:a,offset:e-t};t=n}e:{for(;a;){if(a.nextSibling){a=a.nextSibling;break e}a=a.parentNode}a=void 0}a=Qv(a)}}function U_(t,e){return t&&e?t===e?!0:t&&t.nodeType===3?!1:e&&e.nodeType===3?U_(t,e.parentNode):"contains"in t?t.contains(e):t.compareDocumentPosition?!!(t.compareDocumentPosition(e)&16):!1:!1}function B_(t){t=t!=null&&t.ownerDocument!=null&&t.ownerDocument.defaultView!=null?t.ownerDocument.defaultView:window;for(var e=td(t.document);e instanceof t.HTMLIFrameElement;){try{var a=typeof e.contentWindow.location.href=="string"}catch{a=!1}if(a)t=e.contentWindow;else break;e=td(t.document)}return e}function hg(t){var e=t&&t.nodeName&&t.nodeName.toLowerCase();return e&&(e==="input"&&(t.type==="text"||t.type==="search"||t.type==="tel"||t.type==="url"||t.type==="password")||e==="textarea"||t.contentEditable==="true")}var hE=yi&&"documentMode"in document&&11>=document.documentMode,Wr=null,Sm=null,Al=null,Mm=!1;function $v(t,e,a){var n=a.window===a?a.document:a.nodeType===9?a:a.ownerDocument;Mm||Wr==null||Wr!==td(n)||(n=Wr,"selectionStart"in n&&hg(n)?n={start:n.selectionStart,end:n.selectionEnd}:(n=(n.ownerDocument&&n.ownerDocument.defaultView||window).getSelection(),n={anchorNode:n.anchorNode,anchorOffset:n.anchorOffset,focusNode:n.focusNode,focusOffset:n.focusOffset}),Al&&kl(Al,n)||(Al=n,n=yd(Sm,"onSelect"),0<n.length&&(e=new Td("onSelect","select",null,e,a),t.push({event:e,listeners:n}),e.target=Wr)))}function Fs(t,e){var a={};return a[t.toLowerCase()]=e.toLowerCase(),a["Webkit"+t]="webkit"+e,a["Moz"+t]="moz"+e,a}var Xr={animationend:Fs("Animation","AnimationEnd"),animationiteration:Fs("Animation","AnimationIteration"),animationstart:Fs("Animation","AnimationStart"),transitionrun:Fs("Transition","TransitionRun"),transitionstart:Fs("Transition","TransitionStart"),transitioncancel:Fs("Transition","TransitionCancel"),transitionend:Fs("Transition","TransitionEnd")},Fp={},O_={};yi&&(O_=document.createElement("div").style,"AnimationEvent"in window||(delete Xr.animationend.animation,delete Xr.animationiteration.animation,delete Xr.animationstart.animation),"TransitionEvent"in window||delete Xr.transitionend.transition);function tr(t){if(Fp[t])return Fp[t];if(!Xr[t])return t;var e=Xr[t],a;for(a in e)if(e.hasOwnProperty(a)&&a in O_)return Fp[t]=e[a];return t}var N_=tr("animationend"),F_=tr("animationiteration"),z_=tr("animationstart"),pE=tr("transitionrun"),mE=tr("transitionstart"),gE=tr("transitioncancel"),k_=tr("transitionend"),H_=new Map,bm="abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(" ");bm.push("scrollEnd");function Cn(t,e){H_.set(t,e),$s(e,[t])}var ad=typeof reportError=="function"?reportError:function(t){if(typeof window=="object"&&typeof window.ErrorEvent=="function"){var e=new window.ErrorEvent("error",{bubbles:!0,cancelable:!0,message:typeof t=="object"&&t!==null&&typeof t.message=="string"?String(t.message):String(t),error:t});if(!window.dispatchEvent(e))return}else if(typeof process=="object"&&typeof process.emit=="function"){process.emit("uncaughtException",t);return}console.error(t)},nn=[],Yr=0,pg=0;function wd(){for(var t=Yr,e=pg=Yr=0;e<t;){var a=nn[e];nn[e++]=null;var n=nn[e];nn[e++]=null;var i=nn[e];nn[e++]=null;var s=nn[e];if(nn[e++]=null,n!==null&&i!==null){var r=n.pending;r===null?i.next=i:(i.next=r.next,r.next=i),n.pending=i}s!==0&&V_(a,i,s)}}function Rd(t,e,a,n){nn[Yr++]=t,nn[Yr++]=e,nn[Yr++]=a,nn[Yr++]=n,pg|=n,t.lanes|=n,t=t.alternate,t!==null&&(t.lanes|=n)}function mg(t,e,a,n){return Rd(t,e,a,n),nd(t)}function ar(t,e){return Rd(t,null,null,e),nd(t)}function V_(t,e,a){t.lanes|=a;var n=t.alternate;n!==null&&(n.lanes|=a);for(var i=!1,s=t.return;s!==null;)s.childLanes|=a,n=s.alternate,n!==null&&(n.childLanes|=a),s.tag===22&&(t=s.stateNode,t===null||t._visibility&1||(i=!0)),t=s,s=s.return;return t.tag===3?(s=t.stateNode,i&&e!==null&&(i=31-Ya(a),t=s.hiddenUpdates,n=t[i],n===null?t[i]=[e]:n.push(e),e.lane=a|536870912),s):null}function nd(t){if(50<Bl)throw Bl=0,qm=null,Error(Q(185));for(var e=t.return;e!==null;)t=e,e=t.return;return t.tag===3?t.stateNode:null}var Zr={};function xE(t,e,a,n){this.tag=t,this.key=a,this.sibling=this.child=this.return=this.stateNode=this.type=this.elementType=null,this.index=0,this.refCleanup=this.ref=null,this.pendingProps=e,this.dependencies=this.memoizedState=this.updateQueue=this.memoizedProps=null,this.mode=n,this.subtreeFlags=this.flags=0,this.deletions=null,this.childLanes=this.lanes=0,this.alternate=null}function Ga(t,e,a,n){return new xE(t,e,a,n)}function gg(t){return t=t.prototype,!(!t||!t.isReactComponent)}function gi(t,e){var a=t.alternate;return a===null?(a=Ga(t.tag,e,t.key,t.mode),a.elementType=t.elementType,a.type=t.type,a.stateNode=t.stateNode,a.alternate=t,t.alternate=a):(a.pendingProps=e,a.type=t.type,a.flags=0,a.subtreeFlags=0,a.deletions=null),a.flags=t.flags&65011712,a.childLanes=t.childLanes,a.lanes=t.lanes,a.child=t.child,a.memoizedProps=t.memoizedProps,a.memoizedState=t.memoizedState,a.updateQueue=t.updateQueue,e=t.dependencies,a.dependencies=e===null?null:{lanes:e.lanes,firstContext:e.firstContext},a.sibling=t.sibling,a.index=t.index,a.ref=t.ref,a.refCleanup=t.refCleanup,a}function G_(t,e){t.flags&=65011714;var a=t.alternate;return a===null?(t.childLanes=0,t.lanes=e,t.child=null,t.subtreeFlags=0,t.memoizedProps=null,t.memoizedState=null,t.updateQueue=null,t.dependencies=null,t.stateNode=null):(t.childLanes=a.childLanes,t.lanes=a.lanes,t.child=a.child,t.subtreeFlags=0,t.deletions=null,t.memoizedProps=a.memoizedProps,t.memoizedState=a.memoizedState,t.updateQueue=a.updateQueue,t.type=a.type,e=a.dependencies,t.dependencies=e===null?null:{lanes:e.lanes,firstContext:e.firstContext}),t}function kf(t,e,a,n,i,s){var r=0;if(n=t,typeof t=="function")gg(t)&&(r=1);else if(typeof t=="string")r=_w(t,a,Wn.current)?26:t==="html"||t==="head"||t==="body"?27:5;else e:switch(t){case cm:return t=Ga(31,a,e,i),t.elementType=cm,t.lanes=s,t;case kr:return qs(a.children,i,s,e);case l_:r=8,i|=24;break;case om:return t=Ga(12,a,e,i|2),t.elementType=om,t.lanes=s,t;case lm:return t=Ga(13,a,e,i),t.elementType=lm,t.lanes=s,t;case um:return t=Ga(19,a,e,i),t.elementType=um,t.lanes=s,t;default:if(typeof t=="object"&&t!==null)switch(t.$$typeof){case hi:r=10;break e;case u_:r=9;break e;case ag:r=11;break e;case ng:r=14;break e;case Ji:r=16,n=null;break e}r=29,a=Error(Q(130,t===null?"null":typeof t,"")),n=null}return e=Ga(r,a,e,i),e.elementType=t,e.type=n,e.lanes=s,e}function qs(t,e,a,n){return t=Ga(7,t,n,e),t.lanes=a,t}function zp(t,e,a){return t=Ga(6,t,null,e),t.lanes=a,t}function q_(t){var e=Ga(18,null,null,0);return e.stateNode=t,e}function kp(t,e,a){return e=Ga(4,t.children!==null?t.children:[],t.key,e),e.lanes=a,e.stateNode={containerInfo:t.containerInfo,pendingChildren:null,implementation:t.implementation},e}var ey=new WeakMap;function un(t,e){if(typeof t=="object"&&t!==null){var a=ey.get(t);return a!==void 0?a:(e={value:t,source:e,stack:Bv(e)},ey.set(t,e),e)}return{value:t,source:e,stack:Bv(e)}}var Kr=[],Jr=0,id=null,Hl=0,rn=[],on=0,gs=null,Vn=1,Gn="";function fi(t,e){Kr[Jr++]=Hl,Kr[Jr++]=id,id=t,Hl=e}function W_(t,e,a){rn[on++]=Vn,rn[on++]=Gn,rn[on++]=gs,gs=t;var n=Vn;t=Gn;var i=32-Ya(n)-1;n&=~(1<<i),a+=1;var s=32-Ya(e)+i;if(30<s){var r=i-i%5;s=(n&(1<<r)-1).toString(32),n>>=r,i-=r,Vn=1<<32-Ya(e)+i|a<<i|n,Gn=s+t}else Vn=1<<s|a<<i|n,Gn=t}function xg(t){t.return!==null&&(fi(t,1),W_(t,1,0))}function vg(t){for(;t===id;)id=Kr[--Jr],Kr[Jr]=null,Hl=Kr[--Jr],Kr[Jr]=null;for(;t===gs;)gs=rn[--on],rn[on]=null,Gn=rn[--on],rn[on]=null,Vn=rn[--on],rn[on]=null}function X_(t,e){rn[on++]=Vn,rn[on++]=Gn,rn[on++]=gs,Vn=e.id,Gn=e.overflow,gs=t}var oa=null,St=null,Ye=!1,ls=null,cn=!1,Cm=Error(Q(519));function xs(t){var e=Error(Q(418,1<arguments.length&&arguments[1]!==void 0&&arguments[1]?"text":"HTML",""));throw Vl(un(e,t)),Cm}function ty(t){var e=t.stateNode,a=t.type,n=t.memoizedProps;switch(e[ra]=t,e[Ra]=n,a){case"dialog":ke("cancel",e),ke("close",e);break;case"iframe":case"object":case"embed":ke("load",e);break;case"video":case"audio":for(a=0;a<Xl.length;a++)ke(Xl[a],e);break;case"source":ke("error",e);break;case"img":case"image":case"link":ke("error",e),ke("load",e);break;case"details":ke("toggle",e);break;case"input":ke("invalid",e),M_(e,n.value,n.defaultValue,n.checked,n.defaultChecked,n.type,n.name,!0);break;case"select":ke("invalid",e);break;case"textarea":ke("invalid",e),C_(e,n.value,n.defaultValue,n.children)}a=n.children,typeof a!="string"&&typeof a!="number"&&typeof a!="bigint"||e.textContent===""+a||n.suppressHydrationWarning===!0||IM(e.textContent,a)?(n.popover!=null&&(ke("beforetoggle",e),ke("toggle",e)),n.onScroll!=null&&ke("scroll",e),n.onScrollEnd!=null&&ke("scrollend",e),n.onClick!=null&&(e.onclick=pi),e=!0):e=!1,e||xs(t,!0)}function ay(t){for(oa=t.return;oa;)switch(oa.tag){case 5:case 31:case 13:cn=!1;return;case 27:case 3:cn=!0;return;default:oa=oa.return}}function Or(t){if(t!==oa)return!1;if(!Ye)return ay(t),Ye=!0,!1;var e=t.tag,a;if((a=e!==3&&e!==27)&&((a=e===5)&&(a=t.type,a=!(a!=="form"&&a!=="button")||Km(t.type,t.memoizedProps)),a=!a),a&&St&&xs(t),ay(t),e===13){if(t=t.memoizedState,t=t!==null?t.dehydrated:null,!t)throw Error(Q(317));St=qy(t)}else if(e===31){if(t=t.memoizedState,t=t!==null?t.dehydrated:null,!t)throw Error(Q(317));St=qy(t)}else e===27?(e=St,Ss(t.type)?(t=$m,$m=null,St=t):St=e):St=oa?dn(t.stateNode.nextSibling):null;return!0}function Zs(){St=oa=null,Ye=!1}function Hp(){var t=ls;return t!==null&&(Ea===null?Ea=t:Ea.push.apply(Ea,t),ls=null),t}function Vl(t){ls===null?ls=[t]:ls.push(t)}var Lm=Xn(null),nr=null,mi=null;function ji(t,e,a){gt(Lm,e._currentValue),e._currentValue=a}function xi(t){t._currentValue=Lm.current,aa(Lm)}function Am(t,e,a){for(;t!==null;){var n=t.alternate;if((t.childLanes&e)!==e?(t.childLanes|=e,n!==null&&(n.childLanes|=e)):n!==null&&(n.childLanes&e)!==e&&(n.childLanes|=e),t===a)break;t=t.return}}function Tm(t,e,a,n){var i=t.child;for(i!==null&&(i.return=t);i!==null;){var s=i.dependencies;if(s!==null){var r=i.child;s=s.firstContext;e:for(;s!==null;){var o=s;s=i;for(var l=0;l<e.length;l++)if(o.context===e[l]){s.lanes|=a,o=s.alternate,o!==null&&(o.lanes|=a),Am(s.return,a,t),n||(r=null);break e}s=o.next}}else if(i.tag===18){if(r=i.return,r===null)throw Error(Q(341));r.lanes|=a,s=r.alternate,s!==null&&(s.lanes|=a),Am(r,a,t),r=null}else r=i.child;if(r!==null)r.return=i;else for(r=i;r!==null;){if(r===t){r=null;break}if(i=r.sibling,i!==null){i.return=r.return,r=i;break}r=r.return}i=r}}function yo(t,e,a,n){t=null;for(var i=e,s=!1;i!==null;){if(!s){if((i.flags&524288)!==0)s=!0;else if((i.flags&262144)!==0)break}if(i.tag===10){var r=i.alternate;if(r===null)throw Error(Q(387));if(r=r.memoizedProps,r!==null){var o=i.type;Ka(i.pendingProps.value,r.value)||(t!==null?t.push(o):t=[o])}}else if(i===Qf.current){if(r=i.alternate,r===null)throw Error(Q(387));r.memoizedState.memoizedState!==i.memoizedState.memoizedState&&(t!==null?t.push(Zl):t=[Zl])}i=i.return}t!==null&&Tm(e,t,a,n),e.flags|=262144}function sd(t){for(t=t.firstContext;t!==null;){if(!Ka(t.context._currentValue,t.memoizedValue))return!0;t=t.next}return!1}function Ks(t){nr=t,mi=null,t=t.dependencies,t!==null&&(t.firstContext=null)}function la(t){return Y_(nr,t)}function Af(t,e){return nr===null&&Ks(t),Y_(t,e)}function Y_(t,e){var a=e._currentValue;if(e={context:e,memoizedValue:a,next:null},mi===null){if(t===null)throw Error(Q(308));mi=e,t.dependencies={lanes:0,firstContext:e},t.flags|=524288}else mi=mi.next=e;return a}var vE=typeof AbortController<"u"?AbortController:function(){var t=[],e=this.signal={aborted:!1,addEventListener:function(a,n){t.push(n)}};this.abort=function(){e.aborted=!0,t.forEach(function(a){return a()})}},yE=Jt.unstable_scheduleCallback,_E=Jt.unstable_NormalPriority,qt={$$typeof:hi,Consumer:null,Provider:null,_currentValue:null,_currentValue2:null,_threadCount:0};function yg(){return{controller:new vE,data:new Map,refCount:0}}function nu(t){t.refCount--,t.refCount===0&&yE(_E,function(){t.controller.abort()})}var Tl=null,Im=0,lo=0,to=null;function SE(t,e){if(Tl===null){var a=Tl=[];Im=0,lo=qg(),to={status:"pending",value:void 0,then:function(n){a.push(n)}}}return Im++,e.then(ny,ny),e}function ny(){if(--Im===0&&Tl!==null){to!==null&&(to.status="fulfilled");var t=Tl;Tl=null,lo=0,to=null;for(var e=0;e<t.length;e++)(0,t[e])()}}function ME(t,e){var a=[],n={status:"pending",value:null,reason:null,then:function(i){a.push(i)}};return t.then(function(){n.status="fulfilled",n.value=e;for(var i=0;i<a.length;i++)(0,a[i])(e)},function(i){for(n.status="rejected",n.reason=i,i=0;i<a.length;i++)(0,a[i])(void 0)}),n}var iy=we.S;we.S=function(t,e){oM=Wa(),typeof e=="object"&&e!==null&&typeof e.then=="function"&&SE(t,e),iy!==null&&iy(t,e)};var Ws=Xn(null);function _g(){var t=Ws.current;return t!==null?t:dt.pooledCache}function Hf(t,e){e===null?gt(Ws,Ws.current):gt(Ws,e.pool)}function Z_(){var t=_g();return t===null?null:{parent:qt._currentValue,pool:t}}var _o=Error(Q(460)),Sg=Error(Q(474)),Dd=Error(Q(542)),rd={then:function(){}};function sy(t){return t=t.status,t==="fulfilled"||t==="rejected"}function K_(t,e,a){switch(a=t[a],a===void 0?t.push(e):a!==e&&(e.then(pi,pi),e=a),e.status){case"fulfilled":return e.value;case"rejected":throw t=e.reason,oy(t),t;default:if(typeof e.status=="string")e.then(pi,pi);else{if(t=dt,t!==null&&100<t.shellSuspendCounter)throw Error(Q(482));t=e,t.status="pending",t.then(function(n){if(e.status==="pending"){var i=e;i.status="fulfilled",i.value=n}},function(n){if(e.status==="pending"){var i=e;i.status="rejected",i.reason=n}})}switch(e.status){case"fulfilled":return e.value;case"rejected":throw t=e.reason,oy(t),t}throw Xs=e,_o}}function Hs(t){try{var e=t._init;return e(t._payload)}catch(a){throw a!==null&&typeof a=="object"&&typeof a.then=="function"?(Xs=a,_o):a}}var Xs=null;function ry(){if(Xs===null)throw Error(Q(459));var t=Xs;return Xs=null,t}function oy(t){if(t===_o||t===Dd)throw Error(Q(483))}var ao=null,Gl=0;function Tf(t){var e=Gl;return Gl+=1,ao===null&&(ao=[]),K_(ao,t,e)}function pl(t,e){e=e.props.ref,t.ref=e!==void 0?e:null}function If(t,e){throw e.$$typeof===lI?Error(Q(525)):(t=Object.prototype.toString.call(e),Error(Q(31,t==="[object Object]"?"object with keys {"+Object.keys(e).join(", ")+"}":t)))}function J_(t){function e(f,x){if(t){var S=f.deletions;S===null?(f.deletions=[x],f.flags|=16):S.push(x)}}function a(f,x){if(!t)return null;for(;x!==null;)e(f,x),x=x.sibling;return null}function n(f){for(var x=new Map;f!==null;)f.key!==null?x.set(f.key,f):x.set(f.index,f),f=f.sibling;return x}function i(f,x){return f=gi(f,x),f.index=0,f.sibling=null,f}function s(f,x,S){return f.index=S,t?(S=f.alternate,S!==null?(S=S.index,S<x?(f.flags|=67108866,x):S):(f.flags|=67108866,x)):(f.flags|=1048576,x)}function r(f){return t&&f.alternate===null&&(f.flags|=67108866),f}function o(f,x,S,_){return x===null||x.tag!==6?(x=zp(S,f.mode,_),x.return=f,x):(x=i(x,S),x.return=f,x)}function l(f,x,S,_){var L=S.type;return L===kr?d(f,x,S.props.children,_,S.key):x!==null&&(x.elementType===L||typeof L=="object"&&L!==null&&L.$$typeof===Ji&&Hs(L)===x.type)?(x=i(x,S.props),pl(x,S),x.return=f,x):(x=kf(S.type,S.key,S.props,null,f.mode,_),pl(x,S),x.return=f,x)}function u(f,x,S,_){return x===null||x.tag!==4||x.stateNode.containerInfo!==S.containerInfo||x.stateNode.implementation!==S.implementation?(x=kp(S,f.mode,_),x.return=f,x):(x=i(x,S.children||[]),x.return=f,x)}function d(f,x,S,_,L){return x===null||x.tag!==7?(x=qs(S,f.mode,_,L),x.return=f,x):(x=i(x,S),x.return=f,x)}function p(f,x,S){if(typeof x=="string"&&x!==""||typeof x=="number"||typeof x=="bigint")return x=zp(""+x,f.mode,S),x.return=f,x;if(typeof x=="object"&&x!==null){switch(x.$$typeof){case vf:return S=kf(x.type,x.key,x.props,null,f.mode,S),pl(S,x),S.return=f,S;case yl:return x=kp(x,f.mode,S),x.return=f,x;case Ji:return x=Hs(x),p(f,x,S)}if(_l(x)||dl(x))return x=qs(x,f.mode,S,null),x.return=f,x;if(typeof x.then=="function")return p(f,Tf(x),S);if(x.$$typeof===hi)return p(f,Af(f,x),S);If(f,x)}return null}function c(f,x,S,_){var L=x!==null?x.key:null;if(typeof S=="string"&&S!==""||typeof S=="number"||typeof S=="bigint")return L!==null?null:o(f,x,""+S,_);if(typeof S=="object"&&S!==null){switch(S.$$typeof){case vf:return S.key===L?l(f,x,S,_):null;case yl:return S.key===L?u(f,x,S,_):null;case Ji:return S=Hs(S),c(f,x,S,_)}if(_l(S)||dl(S))return L!==null?null:d(f,x,S,_,null);if(typeof S.then=="function")return c(f,x,Tf(S),_);if(S.$$typeof===hi)return c(f,x,Af(f,S),_);If(f,S)}return null}function h(f,x,S,_,L){if(typeof _=="string"&&_!==""||typeof _=="number"||typeof _=="bigint")return f=f.get(S)||null,o(x,f,""+_,L);if(typeof _=="object"&&_!==null){switch(_.$$typeof){case vf:return f=f.get(_.key===null?S:_.key)||null,l(x,f,_,L);case yl:return f=f.get(_.key===null?S:_.key)||null,u(x,f,_,L);case Ji:return _=Hs(_),h(f,x,S,_,L)}if(_l(_)||dl(_))return f=f.get(S)||null,d(x,f,_,L,null);if(typeof _.then=="function")return h(f,x,S,Tf(_),L);if(_.$$typeof===hi)return h(f,x,S,Af(x,_),L);If(x,_)}return null}function v(f,x,S,_){for(var L=null,C=null,T=x,y=x=0,A=null;T!==null&&y<S.length;y++){T.index>y?(A=T,T=null):A=T.sibling;var E=c(f,T,S[y],_);if(E===null){T===null&&(T=A);break}t&&T&&E.alternate===null&&e(f,T),x=s(E,x,y),C===null?L=E:C.sibling=E,C=E,T=A}if(y===S.length)return a(f,T),Ye&&fi(f,y),L;if(T===null){for(;y<S.length;y++)T=p(f,S[y],_),T!==null&&(x=s(T,x,y),C===null?L=T:C.sibling=T,C=T);return Ye&&fi(f,y),L}for(T=n(T);y<S.length;y++)A=h(T,f,y,S[y],_),A!==null&&(t&&A.alternate!==null&&T.delete(A.key===null?y:A.key),x=s(A,x,y),C===null?L=A:C.sibling=A,C=A);return t&&T.forEach(function(w){return e(f,w)}),Ye&&fi(f,y),L}function b(f,x,S,_){if(S==null)throw Error(Q(151));for(var L=null,C=null,T=x,y=x=0,A=null,E=S.next();T!==null&&!E.done;y++,E=S.next()){T.index>y?(A=T,T=null):A=T.sibling;var w=c(f,T,E.value,_);if(w===null){T===null&&(T=A);break}t&&T&&w.alternate===null&&e(f,T),x=s(w,x,y),C===null?L=w:C.sibling=w,C=w,T=A}if(E.done)return a(f,T),Ye&&fi(f,y),L;if(T===null){for(;!E.done;y++,E=S.next())E=p(f,E.value,_),E!==null&&(x=s(E,x,y),C===null?L=E:C.sibling=E,C=E);return Ye&&fi(f,y),L}for(T=n(T);!E.done;y++,E=S.next())E=h(T,f,y,E.value,_),E!==null&&(t&&E.alternate!==null&&T.delete(E.key===null?y:E.key),x=s(E,x,y),C===null?L=E:C.sibling=E,C=E);return t&&T.forEach(function(B){return e(f,B)}),Ye&&fi(f,y),L}function m(f,x,S,_){if(typeof S=="object"&&S!==null&&S.type===kr&&S.key===null&&(S=S.props.children),typeof S=="object"&&S!==null){switch(S.$$typeof){case vf:e:{for(var L=S.key;x!==null;){if(x.key===L){if(L=S.type,L===kr){if(x.tag===7){a(f,x.sibling),_=i(x,S.props.children),_.return=f,f=_;break e}}else if(x.elementType===L||typeof L=="object"&&L!==null&&L.$$typeof===Ji&&Hs(L)===x.type){a(f,x.sibling),_=i(x,S.props),pl(_,S),_.return=f,f=_;break e}a(f,x);break}else e(f,x);x=x.sibling}S.type===kr?(_=qs(S.props.children,f.mode,_,S.key),_.return=f,f=_):(_=kf(S.type,S.key,S.props,null,f.mode,_),pl(_,S),_.return=f,f=_)}return r(f);case yl:e:{for(L=S.key;x!==null;){if(x.key===L)if(x.tag===4&&x.stateNode.containerInfo===S.containerInfo&&x.stateNode.implementation===S.implementation){a(f,x.sibling),_=i(x,S.children||[]),_.return=f,f=_;break e}else{a(f,x);break}else e(f,x);x=x.sibling}_=kp(S,f.mode,_),_.return=f,f=_}return r(f);case Ji:return S=Hs(S),m(f,x,S,_)}if(_l(S))return v(f,x,S,_);if(dl(S)){if(L=dl(S),typeof L!="function")throw Error(Q(150));return S=L.call(S),b(f,x,S,_)}if(typeof S.then=="function")return m(f,x,Tf(S),_);if(S.$$typeof===hi)return m(f,x,Af(f,S),_);If(f,S)}return typeof S=="string"&&S!==""||typeof S=="number"||typeof S=="bigint"?(S=""+S,x!==null&&x.tag===6?(a(f,x.sibling),_=i(x,S),_.return=f,f=_):(a(f,x),_=zp(S,f.mode,_),_.return=f,f=_),r(f)):a(f,x)}return function(f,x,S,_){try{Gl=0;var L=m(f,x,S,_);return ao=null,L}catch(T){if(T===_o||T===Dd)throw T;var C=Ga(29,T,null,f.mode);return C.lanes=_,C.return=f,C}}}var Js=J_(!0),Q_=J_(!1),Qi=!1;function Mg(t){t.updateQueue={baseState:t.memoizedState,firstBaseUpdate:null,lastBaseUpdate:null,shared:{pending:null,lanes:0,hiddenCallbacks:null},callbacks:null}}function Em(t,e){t=t.updateQueue,e.updateQueue===t&&(e.updateQueue={baseState:t.baseState,firstBaseUpdate:t.firstBaseUpdate,lastBaseUpdate:t.lastBaseUpdate,shared:t.shared,callbacks:null})}function us(t){return{lane:t,tag:0,payload:null,callback:null,next:null}}function cs(t,e,a){var n=t.updateQueue;if(n===null)return null;if(n=n.shared,(et&2)!==0){var i=n.pending;return i===null?e.next=e:(e.next=i.next,i.next=e),n.pending=e,e=nd(t),V_(t,null,a),e}return Rd(t,n,e,a),nd(t)}function Il(t,e,a){if(e=e.updateQueue,e!==null&&(e=e.shared,(a&4194048)!==0)){var n=e.lanes;n&=t.pendingLanes,a|=n,e.lanes=a,m_(t,a)}}function Vp(t,e){var a=t.updateQueue,n=t.alternate;if(n!==null&&(n=n.updateQueue,a===n)){var i=null,s=null;if(a=a.firstBaseUpdate,a!==null){do{var r={lane:a.lane,tag:a.tag,payload:a.payload,callback:null,next:null};s===null?i=s=r:s=s.next=r,a=a.next}while(a!==null);s===null?i=s=e:s=s.next=e}else i=s=e;a={baseState:n.baseState,firstBaseUpdate:i,lastBaseUpdate:s,shared:n.shared,callbacks:n.callbacks},t.updateQueue=a;return}t=a.lastBaseUpdate,t===null?a.firstBaseUpdate=e:t.next=e,a.lastBaseUpdate=e}var wm=!1;function El(){if(wm){var t=to;if(t!==null)throw t}}function wl(t,e,a,n){wm=!1;var i=t.updateQueue;Qi=!1;var s=i.firstBaseUpdate,r=i.lastBaseUpdate,o=i.shared.pending;if(o!==null){i.shared.pending=null;var l=o,u=l.next;l.next=null,r===null?s=u:r.next=u,r=l;var d=t.alternate;d!==null&&(d=d.updateQueue,o=d.lastBaseUpdate,o!==r&&(o===null?d.firstBaseUpdate=u:o.next=u,d.lastBaseUpdate=l))}if(s!==null){var p=i.baseState;r=0,d=u=l=null,o=s;do{var c=o.lane&-536870913,h=c!==o.lane;if(h?(We&c)===c:(n&c)===c){c!==0&&c===lo&&(wm=!0),d!==null&&(d=d.next={lane:0,tag:o.tag,payload:o.payload,callback:null,next:null});e:{var v=t,b=o;c=e;var m=a;switch(b.tag){case 1:if(v=b.payload,typeof v=="function"){p=v.call(m,p,c);break e}p=v;break e;case 3:v.flags=v.flags&-65537|128;case 0:if(v=b.payload,c=typeof v=="function"?v.call(m,p,c):v,c==null)break e;p=Mt({},p,c);break e;case 2:Qi=!0}}c=o.callback,c!==null&&(t.flags|=64,h&&(t.flags|=8192),h=i.callbacks,h===null?i.callbacks=[c]:h.push(c))}else h={lane:c,tag:o.tag,payload:o.payload,callback:o.callback,next:null},d===null?(u=d=h,l=p):d=d.next=h,r|=c;if(o=o.next,o===null){if(o=i.shared.pending,o===null)break;h=o,o=h.next,h.next=null,i.lastBaseUpdate=h,i.shared.pending=null}}while(!0);d===null&&(l=p),i.baseState=l,i.firstBaseUpdate=u,i.lastBaseUpdate=d,s===null&&(i.shared.lanes=0),ys|=r,t.lanes=r,t.memoizedState=p}}function j_(t,e){if(typeof t!="function")throw Error(Q(191,t));t.call(e)}function $_(t,e){var a=t.callbacks;if(a!==null)for(t.callbacks=null,t=0;t<a.length;t++)j_(a[t],e)}var uo=Xn(null),od=Xn(0);function ly(t,e){t=bi,gt(od,t),gt(uo,e),bi=t|e.baseLanes}function Rm(){gt(od,bi),gt(uo,uo.current)}function bg(){bi=od.current,aa(uo),aa(od)}var Ja=Xn(null),fn=null;function $i(t){var e=t.alternate;gt(Nt,Nt.current&1),gt(Ja,t),fn===null&&(e===null||uo.current!==null||e.memoizedState!==null)&&(fn=t)}function Dm(t){gt(Nt,Nt.current),gt(Ja,t),fn===null&&(fn=t)}function eS(t){t.tag===22?(gt(Nt,Nt.current),gt(Ja,t),fn===null&&(fn=t)):es(t)}function es(){gt(Nt,Nt.current),gt(Ja,Ja.current)}function Va(t){aa(Ja),fn===t&&(fn=null),aa(Nt)}var Nt=Xn(0);function ld(t){for(var e=t;e!==null;){if(e.tag===13){var a=e.memoizedState;if(a!==null&&(a=a.dehydrated,a===null||Qm(a)||jm(a)))return e}else if(e.tag===19&&(e.memoizedProps.revealOrder==="forwards"||e.memoizedProps.revealOrder==="backwards"||e.memoizedProps.revealOrder==="unstable_legacy-backwards"||e.memoizedProps.revealOrder==="together")){if((e.flags&128)!==0)return e}else if(e.child!==null){e.child.return=e,e=e.child;continue}if(e===t)break;for(;e.sibling===null;){if(e.return===null||e.return===t)return null;e=e.return}e.sibling.return=e.return,e=e.sibling}return null}var _i=0,Ne=null,lt=null,Vt=null,ud=!1,no=!1,Qs=!1,cd=0,ql=0,io=null,bE=0;function Rt(){throw Error(Q(321))}function Cg(t,e){if(e===null)return!1;for(var a=0;a<e.length&&a<t.length;a++)if(!Ka(t[a],e[a]))return!1;return!0}function Lg(t,e,a,n,i,s){return _i=s,Ne=e,e.memoizedState=null,e.updateQueue=null,e.lanes=0,we.H=t===null||t.memoizedState===null?RS:Og,Qs=!1,s=a(n,i),Qs=!1,no&&(s=aS(e,a,n,i)),tS(t),s}function tS(t){we.H=Wl;var e=lt!==null&&lt.next!==null;if(_i=0,Vt=lt=Ne=null,ud=!1,ql=0,io=null,e)throw Error(Q(300));t===null||Wt||(t=t.dependencies,t!==null&&sd(t)&&(Wt=!0))}function aS(t,e,a,n){Ne=t;var i=0;do{if(no&&(io=null),ql=0,no=!1,25<=i)throw Error(Q(301));if(i+=1,Vt=lt=null,t.updateQueue!=null){var s=t.updateQueue;s.lastEffect=null,s.events=null,s.stores=null,s.memoCache!=null&&(s.memoCache.index=0)}we.H=DS,s=e(a,n)}while(no);return s}function CE(){var t=we.H,e=t.useState()[0];return e=typeof e.then=="function"?iu(e):e,t=t.useState()[0],(lt!==null?lt.memoizedState:null)!==t&&(Ne.flags|=1024),e}function Ag(){var t=cd!==0;return cd=0,t}function Tg(t,e,a){e.updateQueue=t.updateQueue,e.flags&=-2053,t.lanes&=~a}function Ig(t){if(ud){for(t=t.memoizedState;t!==null;){var e=t.queue;e!==null&&(e.pending=null),t=t.next}ud=!1}_i=0,Vt=lt=Ne=null,no=!1,ql=cd=0,io=null}function Sa(){var t={memoizedState:null,baseState:null,baseQueue:null,queue:null,next:null};return Vt===null?Ne.memoizedState=Vt=t:Vt=Vt.next=t,Vt}function Ft(){if(lt===null){var t=Ne.alternate;t=t!==null?t.memoizedState:null}else t=lt.next;var e=Vt===null?Ne.memoizedState:Vt.next;if(e!==null)Vt=e,lt=t;else{if(t===null)throw Ne.alternate===null?Error(Q(467)):Error(Q(310));lt=t,t={memoizedState:lt.memoizedState,baseState:lt.baseState,baseQueue:lt.baseQueue,queue:lt.queue,next:null},Vt===null?Ne.memoizedState=Vt=t:Vt=Vt.next=t}return Vt}function Pd(){return{lastEffect:null,events:null,stores:null,memoCache:null}}function iu(t){var e=ql;return ql+=1,io===null&&(io=[]),t=K_(io,t,e),e=Ne,(Vt===null?e.memoizedState:Vt.next)===null&&(e=e.alternate,we.H=e===null||e.memoizedState===null?RS:Og),t}function Ud(t){if(t!==null&&typeof t=="object"){if(typeof t.then=="function")return iu(t);if(t.$$typeof===hi)return la(t)}throw Error(Q(438,String(t)))}function Eg(t){var e=null,a=Ne.updateQueue;if(a!==null&&(e=a.memoCache),e==null){var n=Ne.alternate;n!==null&&(n=n.updateQueue,n!==null&&(n=n.memoCache,n!=null&&(e={data:n.data.map(function(i){return i.slice()}),index:0})))}if(e==null&&(e={data:[],index:0}),a===null&&(a=Pd(),Ne.updateQueue=a),a.memoCache=e,a=e.data[e.index],a===void 0)for(a=e.data[e.index]=Array(t),n=0;n<t;n++)a[n]=uI;return e.index++,a}function Si(t,e){return typeof e=="function"?e(t):e}function Vf(t){var e=Ft();return wg(e,lt,t)}function wg(t,e,a){var n=t.queue;if(n===null)throw Error(Q(311));n.lastRenderedReducer=a;var i=t.baseQueue,s=n.pending;if(s!==null){if(i!==null){var r=i.next;i.next=s.next,s.next=r}e.baseQueue=i=s,n.pending=null}if(s=t.baseState,i===null)t.memoizedState=s;else{e=i.next;var o=r=null,l=null,u=e,d=!1;do{var p=u.lane&-536870913;if(p!==u.lane?(We&p)===p:(_i&p)===p){var c=u.revertLane;if(c===0)l!==null&&(l=l.next={lane:0,revertLane:0,gesture:null,action:u.action,hasEagerState:u.hasEagerState,eagerState:u.eagerState,next:null}),p===lo&&(d=!0);else if((_i&c)===c){u=u.next,c===lo&&(d=!0);continue}else p={lane:0,revertLane:u.revertLane,gesture:null,action:u.action,hasEagerState:u.hasEagerState,eagerState:u.eagerState,next:null},l===null?(o=l=p,r=s):l=l.next=p,Ne.lanes|=c,ys|=c;p=u.action,Qs&&a(s,p),s=u.hasEagerState?u.eagerState:a(s,p)}else c={lane:p,revertLane:u.revertLane,gesture:u.gesture,action:u.action,hasEagerState:u.hasEagerState,eagerState:u.eagerState,next:null},l===null?(o=l=c,r=s):l=l.next=c,Ne.lanes|=p,ys|=p;u=u.next}while(u!==null&&u!==e);if(l===null?r=s:l.next=o,!Ka(s,t.memoizedState)&&(Wt=!0,d&&(a=to,a!==null)))throw a;t.memoizedState=s,t.baseState=r,t.baseQueue=l,n.lastRenderedState=s}return i===null&&(n.lanes=0),[t.memoizedState,n.dispatch]}function Gp(t){var e=Ft(),a=e.queue;if(a===null)throw Error(Q(311));a.lastRenderedReducer=t;var n=a.dispatch,i=a.pending,s=e.memoizedState;if(i!==null){a.pending=null;var r=i=i.next;do s=t(s,r.action),r=r.next;while(r!==i);Ka(s,e.memoizedState)||(Wt=!0),e.memoizedState=s,e.baseQueue===null&&(e.baseState=s),a.lastRenderedState=s}return[s,n]}function nS(t,e,a){var n=Ne,i=Ft(),s=Ye;if(s){if(a===void 0)throw Error(Q(407));a=a()}else a=e();var r=!Ka((lt||i).memoizedState,a);if(r&&(i.memoizedState=a,Wt=!0),i=i.queue,Rg(rS.bind(null,n,i,t),[t]),i.getSnapshot!==e||r||Vt!==null&&Vt.memoizedState.tag&1){if(n.flags|=2048,co(9,{destroy:void 0},sS.bind(null,n,i,a,e),null),dt===null)throw Error(Q(349));s||(_i&127)!==0||iS(n,e,a)}return a}function iS(t,e,a){t.flags|=16384,t={getSnapshot:e,value:a},e=Ne.updateQueue,e===null?(e=Pd(),Ne.updateQueue=e,e.stores=[t]):(a=e.stores,a===null?e.stores=[t]:a.push(t))}function sS(t,e,a,n){e.value=a,e.getSnapshot=n,oS(e)&&lS(t)}function rS(t,e,a){return a(function(){oS(e)&&lS(t)})}function oS(t){var e=t.getSnapshot;t=t.value;try{var a=e();return!Ka(t,a)}catch{return!0}}function lS(t){var e=ar(t,2);e!==null&&wa(e,t,2)}function Pm(t){var e=Sa();if(typeof t=="function"){var a=t;if(t=a(),Qs){as(!0);try{a()}finally{as(!1)}}}return e.memoizedState=e.baseState=t,e.queue={pending:null,lanes:0,dispatch:null,lastRenderedReducer:Si,lastRenderedState:t},e}function uS(t,e,a,n){return t.baseState=a,wg(t,lt,typeof n=="function"?n:Si)}function LE(t,e,a,n,i){if(Od(t))throw Error(Q(485));if(t=e.action,t!==null){var s={payload:i,action:t,next:null,isTransition:!0,status:"pending",value:null,reason:null,listeners:[],then:function(r){s.listeners.push(r)}};we.T!==null?a(!0):s.isTransition=!1,n(s),a=e.pending,a===null?(s.next=e.pending=s,cS(e,s)):(s.next=a.next,e.pending=a.next=s)}}function cS(t,e){var a=e.action,n=e.payload,i=t.state;if(e.isTransition){var s=we.T,r={};we.T=r;try{var o=a(i,n),l=we.S;l!==null&&l(r,o),uy(t,e,o)}catch(u){Um(t,e,u)}finally{s!==null&&r.types!==null&&(s.types=r.types),we.T=s}}else try{s=a(i,n),uy(t,e,s)}catch(u){Um(t,e,u)}}function uy(t,e,a){a!==null&&typeof a=="object"&&typeof a.then=="function"?a.then(function(n){cy(t,e,n)},function(n){return Um(t,e,n)}):cy(t,e,a)}function cy(t,e,a){e.status="fulfilled",e.value=a,fS(e),t.state=a,e=t.pending,e!==null&&(a=e.next,a===e?t.pending=null:(a=a.next,e.next=a,cS(t,a)))}function Um(t,e,a){var n=t.pending;if(t.pending=null,n!==null){n=n.next;do e.status="rejected",e.reason=a,fS(e),e=e.next;while(e!==n)}t.action=null}function fS(t){t=t.listeners;for(var e=0;e<t.length;e++)(0,t[e])()}function dS(t,e){return e}function fy(t,e){if(Ye){var a=dt.formState;if(a!==null){e:{var n=Ne;if(Ye){if(St){t:{for(var i=St,s=cn;i.nodeType!==8;){if(!s){i=null;break t}if(i=dn(i.nextSibling),i===null){i=null;break t}}s=i.data,i=s==="F!"||s==="F"?i:null}if(i){St=dn(i.nextSibling),n=i.data==="F!";break e}}xs(n)}n=!1}n&&(e=a[0])}}return a=Sa(),a.memoizedState=a.baseState=e,n={pending:null,lanes:0,dispatch:null,lastRenderedReducer:dS,lastRenderedState:e},a.queue=n,a=IS.bind(null,Ne,n),n.dispatch=a,n=Pm(!1),s=Bg.bind(null,Ne,!1,n.queue),n=Sa(),i={state:e,dispatch:null,action:t,pending:null},n.queue=i,a=LE.bind(null,Ne,i,s,a),i.dispatch=a,n.memoizedState=t,[e,a,!1]}function dy(t){var e=Ft();return hS(e,lt,t)}function hS(t,e,a){if(e=wg(t,e,dS)[0],t=Vf(Si)[0],typeof e=="object"&&e!==null&&typeof e.then=="function")try{var n=iu(e)}catch(r){throw r===_o?Dd:r}else n=e;e=Ft();var i=e.queue,s=i.dispatch;return a!==e.memoizedState&&(Ne.flags|=2048,co(9,{destroy:void 0},AE.bind(null,i,a),null)),[n,s,t]}function AE(t,e){t.action=e}function hy(t){var e=Ft(),a=lt;if(a!==null)return hS(e,a,t);Ft(),e=e.memoizedState,a=Ft();var n=a.queue.dispatch;return a.memoizedState=t,[e,n,!1]}function co(t,e,a,n){return t={tag:t,create:a,deps:n,inst:e,next:null},e=Ne.updateQueue,e===null&&(e=Pd(),Ne.updateQueue=e),a=e.lastEffect,a===null?e.lastEffect=t.next=t:(n=a.next,a.next=t,t.next=n,e.lastEffect=t),t}function pS(){return Ft().memoizedState}function Gf(t,e,a,n){var i=Sa();Ne.flags|=t,i.memoizedState=co(1|e,{destroy:void 0},a,n===void 0?null:n)}function Bd(t,e,a,n){var i=Ft();n=n===void 0?null:n;var s=i.memoizedState.inst;lt!==null&&n!==null&&Cg(n,lt.memoizedState.deps)?i.memoizedState=co(e,s,a,n):(Ne.flags|=t,i.memoizedState=co(1|e,s,a,n))}function py(t,e){Gf(8390656,8,t,e)}function Rg(t,e){Bd(2048,8,t,e)}function TE(t){Ne.flags|=4;var e=Ne.updateQueue;if(e===null)e=Pd(),Ne.updateQueue=e,e.events=[t];else{var a=e.events;a===null?e.events=[t]:a.push(t)}}function mS(t){var e=Ft().memoizedState;return TE({ref:e,nextImpl:t}),function(){if((et&2)!==0)throw Error(Q(440));return e.impl.apply(void 0,arguments)}}function gS(t,e){return Bd(4,2,t,e)}function xS(t,e){return Bd(4,4,t,e)}function vS(t,e){if(typeof e=="function"){t=t();var a=e(t);return function(){typeof a=="function"?a():e(null)}}if(e!=null)return t=t(),e.current=t,function(){e.current=null}}function yS(t,e,a){a=a!=null?a.concat([t]):null,Bd(4,4,vS.bind(null,e,t),a)}function Dg(){}function _S(t,e){var a=Ft();e=e===void 0?null:e;var n=a.memoizedState;return e!==null&&Cg(e,n[1])?n[0]:(a.memoizedState=[t,e],t)}function SS(t,e){var a=Ft();e=e===void 0?null:e;var n=a.memoizedState;if(e!==null&&Cg(e,n[1]))return n[0];if(n=t(),Qs){as(!0);try{t()}finally{as(!1)}}return a.memoizedState=[n,e],n}function Pg(t,e,a){return a===void 0||(_i&1073741824)!==0&&(We&261930)===0?t.memoizedState=e:(t.memoizedState=a,t=uM(),Ne.lanes|=t,ys|=t,a)}function MS(t,e,a,n){return Ka(a,e)?a:uo.current!==null?(t=Pg(t,a,n),Ka(t,e)||(Wt=!0),t):(_i&42)===0||(_i&1073741824)!==0&&(We&261930)===0?(Wt=!0,t.memoizedState=a):(t=uM(),Ne.lanes|=t,ys|=t,e)}function bS(t,e,a,n,i){var s=tt.p;tt.p=s!==0&&8>s?s:8;var r=we.T,o={};we.T=o,Bg(t,!1,e,a);try{var l=i(),u=we.S;if(u!==null&&u(o,l),l!==null&&typeof l=="object"&&typeof l.then=="function"){var d=ME(l,n);Rl(t,e,d,Za(t))}else Rl(t,e,n,Za(t))}catch(p){Rl(t,e,{then:function(){},status:"rejected",reason:p},Za())}finally{tt.p=s,r!==null&&o.types!==null&&(r.types=o.types),we.T=r}}function IE(){}function Bm(t,e,a,n){if(t.tag!==5)throw Error(Q(476));var i=CS(t).queue;bS(t,i,e,Gs,a===null?IE:function(){return LS(t),a(n)})}function CS(t){var e=t.memoizedState;if(e!==null)return e;e={memoizedState:Gs,baseState:Gs,baseQueue:null,queue:{pending:null,lanes:0,dispatch:null,lastRenderedReducer:Si,lastRenderedState:Gs},next:null};var a={};return e.next={memoizedState:a,baseState:a,baseQueue:null,queue:{pending:null,lanes:0,dispatch:null,lastRenderedReducer:Si,lastRenderedState:a},next:null},t.memoizedState=e,t=t.alternate,t!==null&&(t.memoizedState=e),e}function LS(t){var e=CS(t);e.next===null&&(e=t.alternate.memoizedState),Rl(t,e.next.queue,{},Za())}function Ug(){return la(Zl)}function AS(){return Ft().memoizedState}function TS(){return Ft().memoizedState}function EE(t){for(var e=t.return;e!==null;){switch(e.tag){case 24:case 3:var a=Za();t=us(a);var n=cs(e,t,a);n!==null&&(wa(n,e,a),Il(n,e,a)),e={cache:yg()},t.payload=e;return}e=e.return}}function wE(t,e,a){var n=Za();a={lane:n,revertLane:0,gesture:null,action:a,hasEagerState:!1,eagerState:null,next:null},Od(t)?ES(e,a):(a=mg(t,e,a,n),a!==null&&(wa(a,t,n),wS(a,e,n)))}function IS(t,e,a){var n=Za();Rl(t,e,a,n)}function Rl(t,e,a,n){var i={lane:n,revertLane:0,gesture:null,action:a,hasEagerState:!1,eagerState:null,next:null};if(Od(t))ES(e,i);else{var s=t.alternate;if(t.lanes===0&&(s===null||s.lanes===0)&&(s=e.lastRenderedReducer,s!==null))try{var r=e.lastRenderedState,o=s(r,a);if(i.hasEagerState=!0,i.eagerState=o,Ka(o,r))return Rd(t,e,i,0),dt===null&&wd(),!1}catch{}if(a=mg(t,e,i,n),a!==null)return wa(a,t,n),wS(a,e,n),!0}return!1}function Bg(t,e,a,n){if(n={lane:2,revertLane:qg(),gesture:null,action:n,hasEagerState:!1,eagerState:null,next:null},Od(t)){if(e)throw Error(Q(479))}else e=mg(t,a,n,2),e!==null&&wa(e,t,2)}function Od(t){var e=t.alternate;return t===Ne||e!==null&&e===Ne}function ES(t,e){no=ud=!0;var a=t.pending;a===null?e.next=e:(e.next=a.next,a.next=e),t.pending=e}function wS(t,e,a){if((a&4194048)!==0){var n=e.lanes;n&=t.pendingLanes,a|=n,e.lanes=a,m_(t,a)}}var Wl={readContext:la,use:Ud,useCallback:Rt,useContext:Rt,useEffect:Rt,useImperativeHandle:Rt,useLayoutEffect:Rt,useInsertionEffect:Rt,useMemo:Rt,useReducer:Rt,useRef:Rt,useState:Rt,useDebugValue:Rt,useDeferredValue:Rt,useTransition:Rt,useSyncExternalStore:Rt,useId:Rt,useHostTransitionStatus:Rt,useFormState:Rt,useActionState:Rt,useOptimistic:Rt,useMemoCache:Rt,useCacheRefresh:Rt};Wl.useEffectEvent=Rt;var RS={readContext:la,use:Ud,useCallback:function(t,e){return Sa().memoizedState=[t,e===void 0?null:e],t},useContext:la,useEffect:py,useImperativeHandle:function(t,e,a){a=a!=null?a.concat([t]):null,Gf(4194308,4,vS.bind(null,e,t),a)},useLayoutEffect:function(t,e){return Gf(4194308,4,t,e)},useInsertionEffect:function(t,e){Gf(4,2,t,e)},useMemo:function(t,e){var a=Sa();e=e===void 0?null:e;var n=t();if(Qs){as(!0);try{t()}finally{as(!1)}}return a.memoizedState=[n,e],n},useReducer:function(t,e,a){var n=Sa();if(a!==void 0){var i=a(e);if(Qs){as(!0);try{a(e)}finally{as(!1)}}}else i=e;return n.memoizedState=n.baseState=i,t={pending:null,lanes:0,dispatch:null,lastRenderedReducer:t,lastRenderedState:i},n.queue=t,t=t.dispatch=wE.bind(null,Ne,t),[n.memoizedState,t]},useRef:function(t){var e=Sa();return t={current:t},e.memoizedState=t},useState:function(t){t=Pm(t);var e=t.queue,a=IS.bind(null,Ne,e);return e.dispatch=a,[t.memoizedState,a]},useDebugValue:Dg,useDeferredValue:function(t,e){var a=Sa();return Pg(a,t,e)},useTransition:function(){var t=Pm(!1);return t=bS.bind(null,Ne,t.queue,!0,!1),Sa().memoizedState=t,[!1,t]},useSyncExternalStore:function(t,e,a){var n=Ne,i=Sa();if(Ye){if(a===void 0)throw Error(Q(407));a=a()}else{if(a=e(),dt===null)throw Error(Q(349));(We&127)!==0||iS(n,e,a)}i.memoizedState=a;var s={value:a,getSnapshot:e};return i.queue=s,py(rS.bind(null,n,s,t),[t]),n.flags|=2048,co(9,{destroy:void 0},sS.bind(null,n,s,a,e),null),a},useId:function(){var t=Sa(),e=dt.identifierPrefix;if(Ye){var a=Gn,n=Vn;a=(n&~(1<<32-Ya(n)-1)).toString(32)+a,e="_"+e+"R_"+a,a=cd++,0<a&&(e+="H"+a.toString(32)),e+="_"}else a=bE++,e="_"+e+"r_"+a.toString(32)+"_";return t.memoizedState=e},useHostTransitionStatus:Ug,useFormState:fy,useActionState:fy,useOptimistic:function(t){var e=Sa();e.memoizedState=e.baseState=t;var a={pending:null,lanes:0,dispatch:null,lastRenderedReducer:null,lastRenderedState:null};return e.queue=a,e=Bg.bind(null,Ne,!0,a),a.dispatch=e,[t,e]},useMemoCache:Eg,useCacheRefresh:function(){return Sa().memoizedState=EE.bind(null,Ne)},useEffectEvent:function(t){var e=Sa(),a={impl:t};return e.memoizedState=a,function(){if((et&2)!==0)throw Error(Q(440));return a.impl.apply(void 0,arguments)}}},Og={readContext:la,use:Ud,useCallback:_S,useContext:la,useEffect:Rg,useImperativeHandle:yS,useInsertionEffect:gS,useLayoutEffect:xS,useMemo:SS,useReducer:Vf,useRef:pS,useState:function(){return Vf(Si)},useDebugValue:Dg,useDeferredValue:function(t,e){var a=Ft();return MS(a,lt.memoizedState,t,e)},useTransition:function(){var t=Vf(Si)[0],e=Ft().memoizedState;return[typeof t=="boolean"?t:iu(t),e]},useSyncExternalStore:nS,useId:AS,useHostTransitionStatus:Ug,useFormState:dy,useActionState:dy,useOptimistic:function(t,e){var a=Ft();return uS(a,lt,t,e)},useMemoCache:Eg,useCacheRefresh:TS};Og.useEffectEvent=mS;var DS={readContext:la,use:Ud,useCallback:_S,useContext:la,useEffect:Rg,useImperativeHandle:yS,useInsertionEffect:gS,useLayoutEffect:xS,useMemo:SS,useReducer:Gp,useRef:pS,useState:function(){return Gp(Si)},useDebugValue:Dg,useDeferredValue:function(t,e){var a=Ft();return lt===null?Pg(a,t,e):MS(a,lt.memoizedState,t,e)},useTransition:function(){var t=Gp(Si)[0],e=Ft().memoizedState;return[typeof t=="boolean"?t:iu(t),e]},useSyncExternalStore:nS,useId:AS,useHostTransitionStatus:Ug,useFormState:hy,useActionState:hy,useOptimistic:function(t,e){var a=Ft();return lt!==null?uS(a,lt,t,e):(a.baseState=t,[t,a.queue.dispatch])},useMemoCache:Eg,useCacheRefresh:TS};DS.useEffectEvent=mS;function qp(t,e,a,n){e=t.memoizedState,a=a(n,e),a=a==null?e:Mt({},e,a),t.memoizedState=a,t.lanes===0&&(t.updateQueue.baseState=a)}var Om={enqueueSetState:function(t,e,a){t=t._reactInternals;var n=Za(),i=us(n);i.payload=e,a!=null&&(i.callback=a),e=cs(t,i,n),e!==null&&(wa(e,t,n),Il(e,t,n))},enqueueReplaceState:function(t,e,a){t=t._reactInternals;var n=Za(),i=us(n);i.tag=1,i.payload=e,a!=null&&(i.callback=a),e=cs(t,i,n),e!==null&&(wa(e,t,n),Il(e,t,n))},enqueueForceUpdate:function(t,e){t=t._reactInternals;var a=Za(),n=us(a);n.tag=2,e!=null&&(n.callback=e),e=cs(t,n,a),e!==null&&(wa(e,t,a),Il(e,t,a))}};function my(t,e,a,n,i,s,r){return t=t.stateNode,typeof t.shouldComponentUpdate=="function"?t.shouldComponentUpdate(n,s,r):e.prototype&&e.prototype.isPureReactComponent?!kl(a,n)||!kl(i,s):!0}function gy(t,e,a,n){t=e.state,typeof e.componentWillReceiveProps=="function"&&e.componentWillReceiveProps(a,n),typeof e.UNSAFE_componentWillReceiveProps=="function"&&e.UNSAFE_componentWillReceiveProps(a,n),e.state!==t&&Om.enqueueReplaceState(e,e.state,null)}function js(t,e){var a=e;if("ref"in e){a={};for(var n in e)n!=="ref"&&(a[n]=e[n])}if(t=t.defaultProps){a===e&&(a=Mt({},a));for(var i in t)a[i]===void 0&&(a[i]=t[i])}return a}function PS(t){ad(t)}function US(t){console.error(t)}function BS(t){ad(t)}function fd(t,e){try{var a=t.onUncaughtError;a(e.value,{componentStack:e.stack})}catch(n){setTimeout(function(){throw n})}}function xy(t,e,a){try{var n=t.onCaughtError;n(a.value,{componentStack:a.stack,errorBoundary:e.tag===1?e.stateNode:null})}catch(i){setTimeout(function(){throw i})}}function Nm(t,e,a){return a=us(a),a.tag=3,a.payload={element:null},a.callback=function(){fd(t,e)},a}function OS(t){return t=us(t),t.tag=3,t}function NS(t,e,a,n){var i=a.type.getDerivedStateFromError;if(typeof i=="function"){var s=n.value;t.payload=function(){return i(s)},t.callback=function(){xy(e,a,n)}}var r=a.stateNode;r!==null&&typeof r.componentDidCatch=="function"&&(t.callback=function(){xy(e,a,n),typeof i!="function"&&(fs===null?fs=new Set([this]):fs.add(this));var o=n.stack;this.componentDidCatch(n.value,{componentStack:o!==null?o:""})})}function RE(t,e,a,n,i){if(a.flags|=32768,n!==null&&typeof n=="object"&&typeof n.then=="function"){if(e=a.alternate,e!==null&&yo(e,a,i,!0),a=Ja.current,a!==null){switch(a.tag){case 31:case 13:return fn===null?gd():a.alternate===null&&Dt===0&&(Dt=3),a.flags&=-257,a.flags|=65536,a.lanes=i,n===rd?a.flags|=16384:(e=a.updateQueue,e===null?a.updateQueue=new Set([n]):e.add(n),tm(t,n,i)),!1;case 22:return a.flags|=65536,n===rd?a.flags|=16384:(e=a.updateQueue,e===null?(e={transitions:null,markerInstances:null,retryQueue:new Set([n])},a.updateQueue=e):(a=e.retryQueue,a===null?e.retryQueue=new Set([n]):a.add(n)),tm(t,n,i)),!1}throw Error(Q(435,a.tag))}return tm(t,n,i),gd(),!1}if(Ye)return e=Ja.current,e!==null?((e.flags&65536)===0&&(e.flags|=256),e.flags|=65536,e.lanes=i,n!==Cm&&(t=Error(Q(422),{cause:n}),Vl(un(t,a)))):(n!==Cm&&(e=Error(Q(423),{cause:n}),Vl(un(e,a))),t=t.current.alternate,t.flags|=65536,i&=-i,t.lanes|=i,n=un(n,a),i=Nm(t.stateNode,n,i),Vp(t,i),Dt!==4&&(Dt=2)),!1;var s=Error(Q(520),{cause:n});if(s=un(s,a),Ul===null?Ul=[s]:Ul.push(s),Dt!==4&&(Dt=2),e===null)return!0;n=un(n,a),a=e;do{switch(a.tag){case 3:return a.flags|=65536,t=i&-i,a.lanes|=t,t=Nm(a.stateNode,n,t),Vp(a,t),!1;case 1:if(e=a.type,s=a.stateNode,(a.flags&128)===0&&(typeof e.getDerivedStateFromError=="function"||s!==null&&typeof s.componentDidCatch=="function"&&(fs===null||!fs.has(s))))return a.flags|=65536,i&=-i,a.lanes|=i,i=OS(i),NS(i,t,a,n),Vp(a,i),!1}a=a.return}while(a!==null);return!1}var Ng=Error(Q(461)),Wt=!1;function sa(t,e,a,n){e.child=t===null?Q_(e,null,a,n):Js(e,t.child,a,n)}function vy(t,e,a,n,i){a=a.render;var s=e.ref;if("ref"in n){var r={};for(var o in n)o!=="ref"&&(r[o]=n[o])}else r=n;return Ks(e),n=Lg(t,e,a,r,s,i),o=Ag(),t!==null&&!Wt?(Tg(t,e,i),Mi(t,e,i)):(Ye&&o&&xg(e),e.flags|=1,sa(t,e,n,i),e.child)}function yy(t,e,a,n,i){if(t===null){var s=a.type;return typeof s=="function"&&!gg(s)&&s.defaultProps===void 0&&a.compare===null?(e.tag=15,e.type=s,FS(t,e,s,n,i)):(t=kf(a.type,null,n,e,e.mode,i),t.ref=e.ref,t.return=e,e.child=t)}if(s=t.child,!Fg(t,i)){var r=s.memoizedProps;if(a=a.compare,a=a!==null?a:kl,a(r,n)&&t.ref===e.ref)return Mi(t,e,i)}return e.flags|=1,t=gi(s,n),t.ref=e.ref,t.return=e,e.child=t}function FS(t,e,a,n,i){if(t!==null){var s=t.memoizedProps;if(kl(s,n)&&t.ref===e.ref)if(Wt=!1,e.pendingProps=n=s,Fg(t,i))(t.flags&131072)!==0&&(Wt=!0);else return e.lanes=t.lanes,Mi(t,e,i)}return Fm(t,e,a,n,i)}function zS(t,e,a,n){var i=n.children,s=t!==null?t.memoizedState:null;if(t===null&&e.stateNode===null&&(e.stateNode={_visibility:1,_pendingMarkers:null,_retryCache:null,_transitions:null}),n.mode==="hidden"){if((e.flags&128)!==0){if(s=s!==null?s.baseLanes|a:a,t!==null){for(n=e.child=t.child,i=0;n!==null;)i=i|n.lanes|n.childLanes,n=n.sibling;n=i&~s}else n=0,e.child=null;return _y(t,e,s,a,n)}if((a&536870912)!==0)e.memoizedState={baseLanes:0,cachePool:null},t!==null&&Hf(e,s!==null?s.cachePool:null),s!==null?ly(e,s):Rm(),eS(e);else return n=e.lanes=536870912,_y(t,e,s!==null?s.baseLanes|a:a,a,n)}else s!==null?(Hf(e,s.cachePool),ly(e,s),es(e),e.memoizedState=null):(t!==null&&Hf(e,null),Rm(),es(e));return sa(t,e,i,a),e.child}function Ml(t,e){return t!==null&&t.tag===22||e.stateNode!==null||(e.stateNode={_visibility:1,_pendingMarkers:null,_retryCache:null,_transitions:null}),e.sibling}function _y(t,e,a,n,i){var s=_g();return s=s===null?null:{parent:qt._currentValue,pool:s},e.memoizedState={baseLanes:a,cachePool:s},t!==null&&Hf(e,null),Rm(),eS(e),t!==null&&yo(t,e,n,!0),e.childLanes=i,null}function qf(t,e){return e=dd({mode:e.mode,children:e.children},t.mode),e.ref=t.ref,t.child=e,e.return=t,e}function Sy(t,e,a){return Js(e,t.child,null,a),t=qf(e,e.pendingProps),t.flags|=2,Va(e),e.memoizedState=null,t}function DE(t,e,a){var n=e.pendingProps,i=(e.flags&128)!==0;if(e.flags&=-129,t===null){if(Ye){if(n.mode==="hidden")return t=qf(e,n),e.lanes=536870912,Ml(null,t);if(Dm(e),(t=St)?(t=RM(t,cn),t=t!==null&&t.data==="&"?t:null,t!==null&&(e.memoizedState={dehydrated:t,treeContext:gs!==null?{id:Vn,overflow:Gn}:null,retryLane:536870912,hydrationErrors:null},a=q_(t),a.return=e,e.child=a,oa=e,St=null)):t=null,t===null)throw xs(e);return e.lanes=536870912,null}return qf(e,n)}var s=t.memoizedState;if(s!==null){var r=s.dehydrated;if(Dm(e),i)if(e.flags&256)e.flags&=-257,e=Sy(t,e,a);else if(e.memoizedState!==null)e.child=t.child,e.flags|=128,e=null;else throw Error(Q(558));else if(Wt||yo(t,e,a,!1),i=(a&t.childLanes)!==0,Wt||i){if(n=dt,n!==null&&(r=g_(n,a),r!==0&&r!==s.retryLane))throw s.retryLane=r,ar(t,r),wa(n,t,r),Ng;gd(),e=Sy(t,e,a)}else t=s.treeContext,St=dn(r.nextSibling),oa=e,Ye=!0,ls=null,cn=!1,t!==null&&X_(e,t),e=qf(e,n),e.flags|=4096;return e}return t=gi(t.child,{mode:n.mode,children:n.children}),t.ref=e.ref,e.child=t,t.return=e,t}function Wf(t,e){var a=e.ref;if(a===null)t!==null&&t.ref!==null&&(e.flags|=4194816);else{if(typeof a!="function"&&typeof a!="object")throw Error(Q(284));(t===null||t.ref!==a)&&(e.flags|=4194816)}}function Fm(t,e,a,n,i){return Ks(e),a=Lg(t,e,a,n,void 0,i),n=Ag(),t!==null&&!Wt?(Tg(t,e,i),Mi(t,e,i)):(Ye&&n&&xg(e),e.flags|=1,sa(t,e,a,i),e.child)}function My(t,e,a,n,i,s){return Ks(e),e.updateQueue=null,a=aS(e,n,a,i),tS(t),n=Ag(),t!==null&&!Wt?(Tg(t,e,s),Mi(t,e,s)):(Ye&&n&&xg(e),e.flags|=1,sa(t,e,a,s),e.child)}function by(t,e,a,n,i){if(Ks(e),e.stateNode===null){var s=Zr,r=a.contextType;typeof r=="object"&&r!==null&&(s=la(r)),s=new a(n,s),e.memoizedState=s.state!==null&&s.state!==void 0?s.state:null,s.updater=Om,e.stateNode=s,s._reactInternals=e,s=e.stateNode,s.props=n,s.state=e.memoizedState,s.refs={},Mg(e),r=a.contextType,s.context=typeof r=="object"&&r!==null?la(r):Zr,s.state=e.memoizedState,r=a.getDerivedStateFromProps,typeof r=="function"&&(qp(e,a,r,n),s.state=e.memoizedState),typeof a.getDerivedStateFromProps=="function"||typeof s.getSnapshotBeforeUpdate=="function"||typeof s.UNSAFE_componentWillMount!="function"&&typeof s.componentWillMount!="function"||(r=s.state,typeof s.componentWillMount=="function"&&s.componentWillMount(),typeof s.UNSAFE_componentWillMount=="function"&&s.UNSAFE_componentWillMount(),r!==s.state&&Om.enqueueReplaceState(s,s.state,null),wl(e,n,s,i),El(),s.state=e.memoizedState),typeof s.componentDidMount=="function"&&(e.flags|=4194308),n=!0}else if(t===null){s=e.stateNode;var o=e.memoizedProps,l=js(a,o);s.props=l;var u=s.context,d=a.contextType;r=Zr,typeof d=="object"&&d!==null&&(r=la(d));var p=a.getDerivedStateFromProps;d=typeof p=="function"||typeof s.getSnapshotBeforeUpdate=="function",o=e.pendingProps!==o,d||typeof s.UNSAFE_componentWillReceiveProps!="function"&&typeof s.componentWillReceiveProps!="function"||(o||u!==r)&&gy(e,s,n,r),Qi=!1;var c=e.memoizedState;s.state=c,wl(e,n,s,i),El(),u=e.memoizedState,o||c!==u||Qi?(typeof p=="function"&&(qp(e,a,p,n),u=e.memoizedState),(l=Qi||my(e,a,l,n,c,u,r))?(d||typeof s.UNSAFE_componentWillMount!="function"&&typeof s.componentWillMount!="function"||(typeof s.componentWillMount=="function"&&s.componentWillMount(),typeof s.UNSAFE_componentWillMount=="function"&&s.UNSAFE_componentWillMount()),typeof s.componentDidMount=="function"&&(e.flags|=4194308)):(typeof s.componentDidMount=="function"&&(e.flags|=4194308),e.memoizedProps=n,e.memoizedState=u),s.props=n,s.state=u,s.context=r,n=l):(typeof s.componentDidMount=="function"&&(e.flags|=4194308),n=!1)}else{s=e.stateNode,Em(t,e),r=e.memoizedProps,d=js(a,r),s.props=d,p=e.pendingProps,c=s.context,u=a.contextType,l=Zr,typeof u=="object"&&u!==null&&(l=la(u)),o=a.getDerivedStateFromProps,(u=typeof o=="function"||typeof s.getSnapshotBeforeUpdate=="function")||typeof s.UNSAFE_componentWillReceiveProps!="function"&&typeof s.componentWillReceiveProps!="function"||(r!==p||c!==l)&&gy(e,s,n,l),Qi=!1,c=e.memoizedState,s.state=c,wl(e,n,s,i),El();var h=e.memoizedState;r!==p||c!==h||Qi||t!==null&&t.dependencies!==null&&sd(t.dependencies)?(typeof o=="function"&&(qp(e,a,o,n),h=e.memoizedState),(d=Qi||my(e,a,d,n,c,h,l)||t!==null&&t.dependencies!==null&&sd(t.dependencies))?(u||typeof s.UNSAFE_componentWillUpdate!="function"&&typeof s.componentWillUpdate!="function"||(typeof s.componentWillUpdate=="function"&&s.componentWillUpdate(n,h,l),typeof s.UNSAFE_componentWillUpdate=="function"&&s.UNSAFE_componentWillUpdate(n,h,l)),typeof s.componentDidUpdate=="function"&&(e.flags|=4),typeof s.getSnapshotBeforeUpdate=="function"&&(e.flags|=1024)):(typeof s.componentDidUpdate!="function"||r===t.memoizedProps&&c===t.memoizedState||(e.flags|=4),typeof s.getSnapshotBeforeUpdate!="function"||r===t.memoizedProps&&c===t.memoizedState||(e.flags|=1024),e.memoizedProps=n,e.memoizedState=h),s.props=n,s.state=h,s.context=l,n=d):(typeof s.componentDidUpdate!="function"||r===t.memoizedProps&&c===t.memoizedState||(e.flags|=4),typeof s.getSnapshotBeforeUpdate!="function"||r===t.memoizedProps&&c===t.memoizedState||(e.flags|=1024),n=!1)}return s=n,Wf(t,e),n=(e.flags&128)!==0,s||n?(s=e.stateNode,a=n&&typeof a.getDerivedStateFromError!="function"?null:s.render(),e.flags|=1,t!==null&&n?(e.child=Js(e,t.child,null,i),e.child=Js(e,null,a,i)):sa(t,e,a,i),e.memoizedState=s.state,t=e.child):t=Mi(t,e,i),t}function Cy(t,e,a,n){return Zs(),e.flags|=256,sa(t,e,a,n),e.child}var Wp={dehydrated:null,treeContext:null,retryLane:0,hydrationErrors:null};function Xp(t){return{baseLanes:t,cachePool:Z_()}}function Yp(t,e,a){return t=t!==null?t.childLanes&~a:0,e&&(t|=qa),t}function kS(t,e,a){var n=e.pendingProps,i=!1,s=(e.flags&128)!==0,r;if((r=s)||(r=t!==null&&t.memoizedState===null?!1:(Nt.current&2)!==0),r&&(i=!0,e.flags&=-129),r=(e.flags&32)!==0,e.flags&=-33,t===null){if(Ye){if(i?$i(e):es(e),(t=St)?(t=RM(t,cn),t=t!==null&&t.data!=="&"?t:null,t!==null&&(e.memoizedState={dehydrated:t,treeContext:gs!==null?{id:Vn,overflow:Gn}:null,retryLane:536870912,hydrationErrors:null},a=q_(t),a.return=e,e.child=a,oa=e,St=null)):t=null,t===null)throw xs(e);return jm(t)?e.lanes=32:e.lanes=536870912,null}var o=n.children;return n=n.fallback,i?(es(e),i=e.mode,o=dd({mode:"hidden",children:o},i),n=qs(n,i,a,null),o.return=e,n.return=e,o.sibling=n,e.child=o,n=e.child,n.memoizedState=Xp(a),n.childLanes=Yp(t,r,a),e.memoizedState=Wp,Ml(null,n)):($i(e),zm(e,o))}var l=t.memoizedState;if(l!==null&&(o=l.dehydrated,o!==null)){if(s)e.flags&256?($i(e),e.flags&=-257,e=Zp(t,e,a)):e.memoizedState!==null?(es(e),e.child=t.child,e.flags|=128,e=null):(es(e),o=n.fallback,i=e.mode,n=dd({mode:"visible",children:n.children},i),o=qs(o,i,a,null),o.flags|=2,n.return=e,o.return=e,n.sibling=o,e.child=n,Js(e,t.child,null,a),n=e.child,n.memoizedState=Xp(a),n.childLanes=Yp(t,r,a),e.memoizedState=Wp,e=Ml(null,n));else if($i(e),jm(o)){if(r=o.nextSibling&&o.nextSibling.dataset,r)var u=r.dgst;r=u,n=Error(Q(419)),n.stack="",n.digest=r,Vl({value:n,source:null,stack:null}),e=Zp(t,e,a)}else if(Wt||yo(t,e,a,!1),r=(a&t.childLanes)!==0,Wt||r){if(r=dt,r!==null&&(n=g_(r,a),n!==0&&n!==l.retryLane))throw l.retryLane=n,ar(t,n),wa(r,t,n),Ng;Qm(o)||gd(),e=Zp(t,e,a)}else Qm(o)?(e.flags|=192,e.child=t.child,e=null):(t=l.treeContext,St=dn(o.nextSibling),oa=e,Ye=!0,ls=null,cn=!1,t!==null&&X_(e,t),e=zm(e,n.children),e.flags|=4096);return e}return i?(es(e),o=n.fallback,i=e.mode,l=t.child,u=l.sibling,n=gi(l,{mode:"hidden",children:n.children}),n.subtreeFlags=l.subtreeFlags&65011712,u!==null?o=gi(u,o):(o=qs(o,i,a,null),o.flags|=2),o.return=e,n.return=e,n.sibling=o,e.child=n,Ml(null,n),n=e.child,o=t.child.memoizedState,o===null?o=Xp(a):(i=o.cachePool,i!==null?(l=qt._currentValue,i=i.parent!==l?{parent:l,pool:l}:i):i=Z_(),o={baseLanes:o.baseLanes|a,cachePool:i}),n.memoizedState=o,n.childLanes=Yp(t,r,a),e.memoizedState=Wp,Ml(t.child,n)):($i(e),a=t.child,t=a.sibling,a=gi(a,{mode:"visible",children:n.children}),a.return=e,a.sibling=null,t!==null&&(r=e.deletions,r===null?(e.deletions=[t],e.flags|=16):r.push(t)),e.child=a,e.memoizedState=null,a)}function zm(t,e){return e=dd({mode:"visible",children:e},t.mode),e.return=t,t.child=e}function dd(t,e){return t=Ga(22,t,null,e),t.lanes=0,t}function Zp(t,e,a){return Js(e,t.child,null,a),t=zm(e,e.pendingProps.children),t.flags|=2,e.memoizedState=null,t}function Ly(t,e,a){t.lanes|=e;var n=t.alternate;n!==null&&(n.lanes|=e),Am(t.return,e,a)}function Kp(t,e,a,n,i,s){var r=t.memoizedState;r===null?t.memoizedState={isBackwards:e,rendering:null,renderingStartTime:0,last:n,tail:a,tailMode:i,treeForkCount:s}:(r.isBackwards=e,r.rendering=null,r.renderingStartTime=0,r.last=n,r.tail=a,r.tailMode=i,r.treeForkCount=s)}function HS(t,e,a){var n=e.pendingProps,i=n.revealOrder,s=n.tail;n=n.children;var r=Nt.current,o=(r&2)!==0;if(o?(r=r&1|2,e.flags|=128):r&=1,gt(Nt,r),sa(t,e,n,a),n=Ye?Hl:0,!o&&t!==null&&(t.flags&128)!==0)e:for(t=e.child;t!==null;){if(t.tag===13)t.memoizedState!==null&&Ly(t,a,e);else if(t.tag===19)Ly(t,a,e);else if(t.child!==null){t.child.return=t,t=t.child;continue}if(t===e)break e;for(;t.sibling===null;){if(t.return===null||t.return===e)break e;t=t.return}t.sibling.return=t.return,t=t.sibling}switch(i){case"forwards":for(a=e.child,i=null;a!==null;)t=a.alternate,t!==null&&ld(t)===null&&(i=a),a=a.sibling;a=i,a===null?(i=e.child,e.child=null):(i=a.sibling,a.sibling=null),Kp(e,!1,i,a,s,n);break;case"backwards":case"unstable_legacy-backwards":for(a=null,i=e.child,e.child=null;i!==null;){if(t=i.alternate,t!==null&&ld(t)===null){e.child=i;break}t=i.sibling,i.sibling=a,a=i,i=t}Kp(e,!0,a,null,s,n);break;case"together":Kp(e,!1,null,null,void 0,n);break;default:e.memoizedState=null}return e.child}function Mi(t,e,a){if(t!==null&&(e.dependencies=t.dependencies),ys|=e.lanes,(a&e.childLanes)===0)if(t!==null){if(yo(t,e,a,!1),(a&e.childLanes)===0)return null}else return null;if(t!==null&&e.child!==t.child)throw Error(Q(153));if(e.child!==null){for(t=e.child,a=gi(t,t.pendingProps),e.child=a,a.return=e;t.sibling!==null;)t=t.sibling,a=a.sibling=gi(t,t.pendingProps),a.return=e;a.sibling=null}return e.child}function Fg(t,e){return(t.lanes&e)!==0?!0:(t=t.dependencies,!!(t!==null&&sd(t)))}function PE(t,e,a){switch(e.tag){case 3:jf(e,e.stateNode.containerInfo),ji(e,qt,t.memoizedState.cache),Zs();break;case 27:case 5:hm(e);break;case 4:jf(e,e.stateNode.containerInfo);break;case 10:ji(e,e.type,e.memoizedProps.value);break;case 31:if(e.memoizedState!==null)return e.flags|=128,Dm(e),null;break;case 13:var n=e.memoizedState;if(n!==null)return n.dehydrated!==null?($i(e),e.flags|=128,null):(a&e.child.childLanes)!==0?kS(t,e,a):($i(e),t=Mi(t,e,a),t!==null?t.sibling:null);$i(e);break;case 19:var i=(t.flags&128)!==0;if(n=(a&e.childLanes)!==0,n||(yo(t,e,a,!1),n=(a&e.childLanes)!==0),i){if(n)return HS(t,e,a);e.flags|=128}if(i=e.memoizedState,i!==null&&(i.rendering=null,i.tail=null,i.lastEffect=null),gt(Nt,Nt.current),n)break;return null;case 22:return e.lanes=0,zS(t,e,a,e.pendingProps);case 24:ji(e,qt,t.memoizedState.cache)}return Mi(t,e,a)}function VS(t,e,a){if(t!==null)if(t.memoizedProps!==e.pendingProps)Wt=!0;else{if(!Fg(t,a)&&(e.flags&128)===0)return Wt=!1,PE(t,e,a);Wt=(t.flags&131072)!==0}else Wt=!1,Ye&&(e.flags&1048576)!==0&&W_(e,Hl,e.index);switch(e.lanes=0,e.tag){case 16:e:{var n=e.pendingProps;if(t=Hs(e.elementType),e.type=t,typeof t=="function")gg(t)?(n=js(t,n),e.tag=1,e=by(null,e,t,n,a)):(e.tag=0,e=Fm(null,e,t,n,a));else{if(t!=null){var i=t.$$typeof;if(i===ag){e.tag=11,e=vy(null,e,t,n,a);break e}else if(i===ng){e.tag=14,e=yy(null,e,t,n,a);break e}}throw e=fm(t)||t,Error(Q(306,e,""))}}return e;case 0:return Fm(t,e,e.type,e.pendingProps,a);case 1:return n=e.type,i=js(n,e.pendingProps),by(t,e,n,i,a);case 3:e:{if(jf(e,e.stateNode.containerInfo),t===null)throw Error(Q(387));n=e.pendingProps;var s=e.memoizedState;i=s.element,Em(t,e),wl(e,n,null,a);var r=e.memoizedState;if(n=r.cache,ji(e,qt,n),n!==s.cache&&Tm(e,[qt],a,!0),El(),n=r.element,s.isDehydrated)if(s={element:n,isDehydrated:!1,cache:r.cache},e.updateQueue.baseState=s,e.memoizedState=s,e.flags&256){e=Cy(t,e,n,a);break e}else if(n!==i){i=un(Error(Q(424)),e),Vl(i),e=Cy(t,e,n,a);break e}else for(t=e.stateNode.containerInfo,t.nodeType===9?t=t.body:t=t.nodeName==="HTML"?t.ownerDocument.body:t,St=dn(t.firstChild),oa=e,Ye=!0,ls=null,cn=!0,a=Q_(e,null,n,a),e.child=a;a;)a.flags=a.flags&-3|4096,a=a.sibling;else{if(Zs(),n===i){e=Mi(t,e,a);break e}sa(t,e,n,a)}e=e.child}return e;case 26:return Wf(t,e),t===null?(a=Yy(e.type,null,e.pendingProps,null))?e.memoizedState=a:Ye||(a=e.type,t=e.pendingProps,n=_d(os.current).createElement(a),n[ra]=e,n[Ra]=t,ua(n,a,t),ta(n),e.stateNode=n):e.memoizedState=Yy(e.type,t.memoizedProps,e.pendingProps,t.memoizedState),null;case 27:return hm(e),t===null&&Ye&&(n=e.stateNode=DM(e.type,e.pendingProps,os.current),oa=e,cn=!0,i=St,Ss(e.type)?($m=i,St=dn(n.firstChild)):St=i),sa(t,e,e.pendingProps.children,a),Wf(t,e),t===null&&(e.flags|=4194304),e.child;case 5:return t===null&&Ye&&((i=n=St)&&(n=ow(n,e.type,e.pendingProps,cn),n!==null?(e.stateNode=n,oa=e,St=dn(n.firstChild),cn=!1,i=!0):i=!1),i||xs(e)),hm(e),i=e.type,s=e.pendingProps,r=t!==null?t.memoizedProps:null,n=s.children,Km(i,s)?n=null:r!==null&&Km(i,r)&&(e.flags|=32),e.memoizedState!==null&&(i=Lg(t,e,CE,null,null,a),Zl._currentValue=i),Wf(t,e),sa(t,e,n,a),e.child;case 6:return t===null&&Ye&&((t=a=St)&&(a=lw(a,e.pendingProps,cn),a!==null?(e.stateNode=a,oa=e,St=null,t=!0):t=!1),t||xs(e)),null;case 13:return kS(t,e,a);case 4:return jf(e,e.stateNode.containerInfo),n=e.pendingProps,t===null?e.child=Js(e,null,n,a):sa(t,e,n,a),e.child;case 11:return vy(t,e,e.type,e.pendingProps,a);case 7:return sa(t,e,e.pendingProps,a),e.child;case 8:return sa(t,e,e.pendingProps.children,a),e.child;case 12:return sa(t,e,e.pendingProps.children,a),e.child;case 10:return n=e.pendingProps,ji(e,e.type,n.value),sa(t,e,n.children,a),e.child;case 9:return i=e.type._context,n=e.pendingProps.children,Ks(e),i=la(i),n=n(i),e.flags|=1,sa(t,e,n,a),e.child;case 14:return yy(t,e,e.type,e.pendingProps,a);case 15:return FS(t,e,e.type,e.pendingProps,a);case 19:return HS(t,e,a);case 31:return DE(t,e,a);case 22:return zS(t,e,a,e.pendingProps);case 24:return Ks(e),n=la(qt),t===null?(i=_g(),i===null&&(i=dt,s=yg(),i.pooledCache=s,s.refCount++,s!==null&&(i.pooledCacheLanes|=a),i=s),e.memoizedState={parent:n,cache:i},Mg(e),ji(e,qt,i)):((t.lanes&a)!==0&&(Em(t,e),wl(e,null,null,a),El()),i=t.memoizedState,s=e.memoizedState,i.parent!==n?(i={parent:n,cache:n},e.memoizedState=i,e.lanes===0&&(e.memoizedState=e.updateQueue.baseState=i),ji(e,qt,n)):(n=s.cache,ji(e,qt,n),n!==i.cache&&Tm(e,[qt],a,!0))),sa(t,e,e.pendingProps.children,a),e.child;case 29:throw e.pendingProps}throw Error(Q(156,e.tag))}function oi(t){t.flags|=4}function Jp(t,e,a,n,i){if((e=(t.mode&32)!==0)&&(e=!1),e){if(t.flags|=16777216,(i&335544128)===i)if(t.stateNode.complete)t.flags|=8192;else if(dM())t.flags|=8192;else throw Xs=rd,Sg}else t.flags&=-16777217}function Ay(t,e){if(e.type!=="stylesheet"||(e.state.loading&4)!==0)t.flags&=-16777217;else if(t.flags|=16777216,!BM(e))if(dM())t.flags|=8192;else throw Xs=rd,Sg}function Ef(t,e){e!==null&&(t.flags|=4),t.flags&16384&&(e=t.tag!==22?h_():536870912,t.lanes|=e,fo|=e)}function ml(t,e){if(!Ye)switch(t.tailMode){case"hidden":e=t.tail;for(var a=null;e!==null;)e.alternate!==null&&(a=e),e=e.sibling;a===null?t.tail=null:a.sibling=null;break;case"collapsed":a=t.tail;for(var n=null;a!==null;)a.alternate!==null&&(n=a),a=a.sibling;n===null?e||t.tail===null?t.tail=null:t.tail.sibling=null:n.sibling=null}}function _t(t){var e=t.alternate!==null&&t.alternate.child===t.child,a=0,n=0;if(e)for(var i=t.child;i!==null;)a|=i.lanes|i.childLanes,n|=i.subtreeFlags&65011712,n|=i.flags&65011712,i.return=t,i=i.sibling;else for(i=t.child;i!==null;)a|=i.lanes|i.childLanes,n|=i.subtreeFlags,n|=i.flags,i.return=t,i=i.sibling;return t.subtreeFlags|=n,t.childLanes=a,e}function UE(t,e,a){var n=e.pendingProps;switch(vg(e),e.tag){case 16:case 15:case 0:case 11:case 7:case 8:case 12:case 9:case 14:return _t(e),null;case 1:return _t(e),null;case 3:return a=e.stateNode,n=null,t!==null&&(n=t.memoizedState.cache),e.memoizedState.cache!==n&&(e.flags|=2048),xi(qt),so(),a.pendingContext&&(a.context=a.pendingContext,a.pendingContext=null),(t===null||t.child===null)&&(Or(e)?oi(e):t===null||t.memoizedState.isDehydrated&&(e.flags&256)===0||(e.flags|=1024,Hp())),_t(e),null;case 26:var i=e.type,s=e.memoizedState;return t===null?(oi(e),s!==null?(_t(e),Ay(e,s)):(_t(e),Jp(e,i,null,n,a))):s?s!==t.memoizedState?(oi(e),_t(e),Ay(e,s)):(_t(e),e.flags&=-16777217):(t=t.memoizedProps,t!==n&&oi(e),_t(e),Jp(e,i,t,n,a)),null;case 27:if($f(e),a=os.current,i=e.type,t!==null&&e.stateNode!=null)t.memoizedProps!==n&&oi(e);else{if(!n){if(e.stateNode===null)throw Error(Q(166));return _t(e),null}t=Wn.current,Or(e)?ty(e,t):(t=DM(i,n,a),e.stateNode=t,oi(e))}return _t(e),null;case 5:if($f(e),i=e.type,t!==null&&e.stateNode!=null)t.memoizedProps!==n&&oi(e);else{if(!n){if(e.stateNode===null)throw Error(Q(166));return _t(e),null}if(s=Wn.current,Or(e))ty(e,s);else{var r=_d(os.current);switch(s){case 1:s=r.createElementNS("http://www.w3.org/2000/svg",i);break;case 2:s=r.createElementNS("http://www.w3.org/1998/Math/MathML",i);break;default:switch(i){case"svg":s=r.createElementNS("http://www.w3.org/2000/svg",i);break;case"math":s=r.createElementNS("http://www.w3.org/1998/Math/MathML",i);break;case"script":s=r.createElement("div"),s.innerHTML="<script><\/script>",s=s.removeChild(s.firstChild);break;case"select":s=typeof n.is=="string"?r.createElement("select",{is:n.is}):r.createElement("select"),n.multiple?s.multiple=!0:n.size&&(s.size=n.size);break;default:s=typeof n.is=="string"?r.createElement(i,{is:n.is}):r.createElement(i)}}s[ra]=e,s[Ra]=n;e:for(r=e.child;r!==null;){if(r.tag===5||r.tag===6)s.appendChild(r.stateNode);else if(r.tag!==4&&r.tag!==27&&r.child!==null){r.child.return=r,r=r.child;continue}if(r===e)break e;for(;r.sibling===null;){if(r.return===null||r.return===e)break e;r=r.return}r.sibling.return=r.return,r=r.sibling}e.stateNode=s;e:switch(ua(s,i,n),i){case"button":case"input":case"select":case"textarea":n=!!n.autoFocus;break e;case"img":n=!0;break e;default:n=!1}n&&oi(e)}}return _t(e),Jp(e,e.type,t===null?null:t.memoizedProps,e.pendingProps,a),null;case 6:if(t&&e.stateNode!=null)t.memoizedProps!==n&&oi(e);else{if(typeof n!="string"&&e.stateNode===null)throw Error(Q(166));if(t=os.current,Or(e)){if(t=e.stateNode,a=e.memoizedProps,n=null,i=oa,i!==null)switch(i.tag){case 27:case 5:n=i.memoizedProps}t[ra]=e,t=!!(t.nodeValue===a||n!==null&&n.suppressHydrationWarning===!0||IM(t.nodeValue,a)),t||xs(e,!0)}else t=_d(t).createTextNode(n),t[ra]=e,e.stateNode=t}return _t(e),null;case 31:if(a=e.memoizedState,t===null||t.memoizedState!==null){if(n=Or(e),a!==null){if(t===null){if(!n)throw Error(Q(318));if(t=e.memoizedState,t=t!==null?t.dehydrated:null,!t)throw Error(Q(557));t[ra]=e}else Zs(),(e.flags&128)===0&&(e.memoizedState=null),e.flags|=4;_t(e),t=!1}else a=Hp(),t!==null&&t.memoizedState!==null&&(t.memoizedState.hydrationErrors=a),t=!0;if(!t)return e.flags&256?(Va(e),e):(Va(e),null);if((e.flags&128)!==0)throw Error(Q(558))}return _t(e),null;case 13:if(n=e.memoizedState,t===null||t.memoizedState!==null&&t.memoizedState.dehydrated!==null){if(i=Or(e),n!==null&&n.dehydrated!==null){if(t===null){if(!i)throw Error(Q(318));if(i=e.memoizedState,i=i!==null?i.dehydrated:null,!i)throw Error(Q(317));i[ra]=e}else Zs(),(e.flags&128)===0&&(e.memoizedState=null),e.flags|=4;_t(e),i=!1}else i=Hp(),t!==null&&t.memoizedState!==null&&(t.memoizedState.hydrationErrors=i),i=!0;if(!i)return e.flags&256?(Va(e),e):(Va(e),null)}return Va(e),(e.flags&128)!==0?(e.lanes=a,e):(a=n!==null,t=t!==null&&t.memoizedState!==null,a&&(n=e.child,i=null,n.alternate!==null&&n.alternate.memoizedState!==null&&n.alternate.memoizedState.cachePool!==null&&(i=n.alternate.memoizedState.cachePool.pool),s=null,n.memoizedState!==null&&n.memoizedState.cachePool!==null&&(s=n.memoizedState.cachePool.pool),s!==i&&(n.flags|=2048)),a!==t&&a&&(e.child.flags|=8192),Ef(e,e.updateQueue),_t(e),null);case 4:return so(),t===null&&Wg(e.stateNode.containerInfo),_t(e),null;case 10:return xi(e.type),_t(e),null;case 19:if(aa(Nt),n=e.memoizedState,n===null)return _t(e),null;if(i=(e.flags&128)!==0,s=n.rendering,s===null)if(i)ml(n,!1);else{if(Dt!==0||t!==null&&(t.flags&128)!==0)for(t=e.child;t!==null;){if(s=ld(t),s!==null){for(e.flags|=128,ml(n,!1),t=s.updateQueue,e.updateQueue=t,Ef(e,t),e.subtreeFlags=0,t=a,a=e.child;a!==null;)G_(a,t),a=a.sibling;return gt(Nt,Nt.current&1|2),Ye&&fi(e,n.treeForkCount),e.child}t=t.sibling}n.tail!==null&&Wa()>pd&&(e.flags|=128,i=!0,ml(n,!1),e.lanes=4194304)}else{if(!i)if(t=ld(s),t!==null){if(e.flags|=128,i=!0,t=t.updateQueue,e.updateQueue=t,Ef(e,t),ml(n,!0),n.tail===null&&n.tailMode==="hidden"&&!s.alternate&&!Ye)return _t(e),null}else 2*Wa()-n.renderingStartTime>pd&&a!==536870912&&(e.flags|=128,i=!0,ml(n,!1),e.lanes=4194304);n.isBackwards?(s.sibling=e.child,e.child=s):(t=n.last,t!==null?t.sibling=s:e.child=s,n.last=s)}return n.tail!==null?(t=n.tail,n.rendering=t,n.tail=t.sibling,n.renderingStartTime=Wa(),t.sibling=null,a=Nt.current,gt(Nt,i?a&1|2:a&1),Ye&&fi(e,n.treeForkCount),t):(_t(e),null);case 22:case 23:return Va(e),bg(),n=e.memoizedState!==null,t!==null?t.memoizedState!==null!==n&&(e.flags|=8192):n&&(e.flags|=8192),n?(a&536870912)!==0&&(e.flags&128)===0&&(_t(e),e.subtreeFlags&6&&(e.flags|=8192)):_t(e),a=e.updateQueue,a!==null&&Ef(e,a.retryQueue),a=null,t!==null&&t.memoizedState!==null&&t.memoizedState.cachePool!==null&&(a=t.memoizedState.cachePool.pool),n=null,e.memoizedState!==null&&e.memoizedState.cachePool!==null&&(n=e.memoizedState.cachePool.pool),n!==a&&(e.flags|=2048),t!==null&&aa(Ws),null;case 24:return a=null,t!==null&&(a=t.memoizedState.cache),e.memoizedState.cache!==a&&(e.flags|=2048),xi(qt),_t(e),null;case 25:return null;case 30:return null}throw Error(Q(156,e.tag))}function BE(t,e){switch(vg(e),e.tag){case 1:return t=e.flags,t&65536?(e.flags=t&-65537|128,e):null;case 3:return xi(qt),so(),t=e.flags,(t&65536)!==0&&(t&128)===0?(e.flags=t&-65537|128,e):null;case 26:case 27:case 5:return $f(e),null;case 31:if(e.memoizedState!==null){if(Va(e),e.alternate===null)throw Error(Q(340));Zs()}return t=e.flags,t&65536?(e.flags=t&-65537|128,e):null;case 13:if(Va(e),t=e.memoizedState,t!==null&&t.dehydrated!==null){if(e.alternate===null)throw Error(Q(340));Zs()}return t=e.flags,t&65536?(e.flags=t&-65537|128,e):null;case 19:return aa(Nt),null;case 4:return so(),null;case 10:return xi(e.type),null;case 22:case 23:return Va(e),bg(),t!==null&&aa(Ws),t=e.flags,t&65536?(e.flags=t&-65537|128,e):null;case 24:return xi(qt),null;case 25:return null;default:return null}}function GS(t,e){switch(vg(e),e.tag){case 3:xi(qt),so();break;case 26:case 27:case 5:$f(e);break;case 4:so();break;case 31:e.memoizedState!==null&&Va(e);break;case 13:Va(e);break;case 19:aa(Nt);break;case 10:xi(e.type);break;case 22:case 23:Va(e),bg(),t!==null&&aa(Ws);break;case 24:xi(qt)}}function su(t,e){try{var a=e.updateQueue,n=a!==null?a.lastEffect:null;if(n!==null){var i=n.next;a=i;do{if((a.tag&t)===t){n=void 0;var s=a.create,r=a.inst;n=s(),r.destroy=n}a=a.next}while(a!==i)}}catch(o){st(e,e.return,o)}}function vs(t,e,a){try{var n=e.updateQueue,i=n!==null?n.lastEffect:null;if(i!==null){var s=i.next;n=s;do{if((n.tag&t)===t){var r=n.inst,o=r.destroy;if(o!==void 0){r.destroy=void 0,i=e;var l=a,u=o;try{u()}catch(d){st(i,l,d)}}}n=n.next}while(n!==s)}}catch(d){st(e,e.return,d)}}function qS(t){var e=t.updateQueue;if(e!==null){var a=t.stateNode;try{$_(e,a)}catch(n){st(t,t.return,n)}}}function WS(t,e,a){a.props=js(t.type,t.memoizedProps),a.state=t.memoizedState;try{a.componentWillUnmount()}catch(n){st(t,e,n)}}function Dl(t,e){try{var a=t.ref;if(a!==null){switch(t.tag){case 26:case 27:case 5:var n=t.stateNode;break;case 30:n=t.stateNode;break;default:n=t.stateNode}typeof a=="function"?t.refCleanup=a(n):a.current=n}}catch(i){st(t,e,i)}}function qn(t,e){var a=t.ref,n=t.refCleanup;if(a!==null)if(typeof n=="function")try{n()}catch(i){st(t,e,i)}finally{t.refCleanup=null,t=t.alternate,t!=null&&(t.refCleanup=null)}else if(typeof a=="function")try{a(null)}catch(i){st(t,e,i)}else a.current=null}function XS(t){var e=t.type,a=t.memoizedProps,n=t.stateNode;try{e:switch(e){case"button":case"input":case"select":case"textarea":a.autoFocus&&n.focus();break e;case"img":a.src?n.src=a.src:a.srcSet&&(n.srcset=a.srcSet)}}catch(i){st(t,t.return,i)}}function Qp(t,e,a){try{var n=t.stateNode;tw(n,t.type,a,e),n[Ra]=e}catch(i){st(t,t.return,i)}}function YS(t){return t.tag===5||t.tag===3||t.tag===26||t.tag===27&&Ss(t.type)||t.tag===4}function jp(t){e:for(;;){for(;t.sibling===null;){if(t.return===null||YS(t.return))return null;t=t.return}for(t.sibling.return=t.return,t=t.sibling;t.tag!==5&&t.tag!==6&&t.tag!==18;){if(t.tag===27&&Ss(t.type)||t.flags&2||t.child===null||t.tag===4)continue e;t.child.return=t,t=t.child}if(!(t.flags&2))return t.stateNode}}function km(t,e,a){var n=t.tag;if(n===5||n===6)t=t.stateNode,e?(a.nodeType===9?a.body:a.nodeName==="HTML"?a.ownerDocument.body:a).insertBefore(t,e):(e=a.nodeType===9?a.body:a.nodeName==="HTML"?a.ownerDocument.body:a,e.appendChild(t),a=a._reactRootContainer,a!=null||e.onclick!==null||(e.onclick=pi));else if(n!==4&&(n===27&&Ss(t.type)&&(a=t.stateNode,e=null),t=t.child,t!==null))for(km(t,e,a),t=t.sibling;t!==null;)km(t,e,a),t=t.sibling}function hd(t,e,a){var n=t.tag;if(n===5||n===6)t=t.stateNode,e?a.insertBefore(t,e):a.appendChild(t);else if(n!==4&&(n===27&&Ss(t.type)&&(a=t.stateNode),t=t.child,t!==null))for(hd(t,e,a),t=t.sibling;t!==null;)hd(t,e,a),t=t.sibling}function ZS(t){var e=t.stateNode,a=t.memoizedProps;try{for(var n=t.type,i=e.attributes;i.length;)e.removeAttributeNode(i[0]);ua(e,n,a),e[ra]=t,e[Ra]=a}catch(s){st(t,t.return,s)}}var di=!1,Gt=!1,$p=!1,Ty=typeof WeakSet=="function"?WeakSet:Set,ea=null;function OE(t,e){if(t=t.containerInfo,Ym=Cd,t=B_(t),hg(t)){if("selectionStart"in t)var a={start:t.selectionStart,end:t.selectionEnd};else e:{a=(a=t.ownerDocument)&&a.defaultView||window;var n=a.getSelection&&a.getSelection();if(n&&n.rangeCount!==0){a=n.anchorNode;var i=n.anchorOffset,s=n.focusNode;n=n.focusOffset;try{a.nodeType,s.nodeType}catch{a=null;break e}var r=0,o=-1,l=-1,u=0,d=0,p=t,c=null;t:for(;;){for(var h;p!==a||i!==0&&p.nodeType!==3||(o=r+i),p!==s||n!==0&&p.nodeType!==3||(l=r+n),p.nodeType===3&&(r+=p.nodeValue.length),(h=p.firstChild)!==null;)c=p,p=h;for(;;){if(p===t)break t;if(c===a&&++u===i&&(o=r),c===s&&++d===n&&(l=r),(h=p.nextSibling)!==null)break;p=c,c=p.parentNode}p=h}a=o===-1||l===-1?null:{start:o,end:l}}else a=null}a=a||{start:0,end:0}}else a=null;for(Zm={focusedElem:t,selectionRange:a},Cd=!1,ea=e;ea!==null;)if(e=ea,t=e.child,(e.subtreeFlags&1028)!==0&&t!==null)t.return=e,ea=t;else for(;ea!==null;){switch(e=ea,s=e.alternate,t=e.flags,e.tag){case 0:if((t&4)!==0&&(t=e.updateQueue,t=t!==null?t.events:null,t!==null))for(a=0;a<t.length;a++)i=t[a],i.ref.impl=i.nextImpl;break;case 11:case 15:break;case 1:if((t&1024)!==0&&s!==null){t=void 0,a=e,i=s.memoizedProps,s=s.memoizedState,n=a.stateNode;try{var v=js(a.type,i);t=n.getSnapshotBeforeUpdate(v,s),n.__reactInternalSnapshotBeforeUpdate=t}catch(b){st(a,a.return,b)}}break;case 3:if((t&1024)!==0){if(t=e.stateNode.containerInfo,a=t.nodeType,a===9)Jm(t);else if(a===1)switch(t.nodeName){case"HEAD":case"HTML":case"BODY":Jm(t);break;default:t.textContent=""}}break;case 5:case 26:case 27:case 6:case 4:case 17:break;default:if((t&1024)!==0)throw Error(Q(163))}if(t=e.sibling,t!==null){t.return=e.return,ea=t;break}ea=e.return}}function KS(t,e,a){var n=a.flags;switch(a.tag){case 0:case 11:case 15:ui(t,a),n&4&&su(5,a);break;case 1:if(ui(t,a),n&4)if(t=a.stateNode,e===null)try{t.componentDidMount()}catch(r){st(a,a.return,r)}else{var i=js(a.type,e.memoizedProps);e=e.memoizedState;try{t.componentDidUpdate(i,e,t.__reactInternalSnapshotBeforeUpdate)}catch(r){st(a,a.return,r)}}n&64&&qS(a),n&512&&Dl(a,a.return);break;case 3:if(ui(t,a),n&64&&(t=a.updateQueue,t!==null)){if(e=null,a.child!==null)switch(a.child.tag){case 27:case 5:e=a.child.stateNode;break;case 1:e=a.child.stateNode}try{$_(t,e)}catch(r){st(a,a.return,r)}}break;case 27:e===null&&n&4&&ZS(a);case 26:case 5:ui(t,a),e===null&&n&4&&XS(a),n&512&&Dl(a,a.return);break;case 12:ui(t,a);break;case 31:ui(t,a),n&4&&jS(t,a);break;case 13:ui(t,a),n&4&&$S(t,a),n&64&&(t=a.memoizedState,t!==null&&(t=t.dehydrated,t!==null&&(a=WE.bind(null,a),uw(t,a))));break;case 22:if(n=a.memoizedState!==null||di,!n){e=e!==null&&e.memoizedState!==null||Gt,i=di;var s=Gt;di=n,(Gt=e)&&!s?ci(t,a,(a.subtreeFlags&8772)!==0):ui(t,a),di=i,Gt=s}break;case 30:break;default:ui(t,a)}}function JS(t){var e=t.alternate;e!==null&&(t.alternate=null,JS(e)),t.child=null,t.deletions=null,t.sibling=null,t.tag===5&&(e=t.stateNode,e!==null&&og(e)),t.stateNode=null,t.return=null,t.dependencies=null,t.memoizedProps=null,t.memoizedState=null,t.pendingProps=null,t.stateNode=null,t.updateQueue=null}var Lt=null,Ia=!1;function li(t,e,a){for(a=a.child;a!==null;)QS(t,e,a),a=a.sibling}function QS(t,e,a){if(Xa&&typeof Xa.onCommitFiberUnmount=="function")try{Xa.onCommitFiberUnmount(jl,a)}catch{}switch(a.tag){case 26:Gt||qn(a,e),li(t,e,a),a.memoizedState?a.memoizedState.count--:a.stateNode&&(a=a.stateNode,a.parentNode.removeChild(a));break;case 27:Gt||qn(a,e);var n=Lt,i=Ia;Ss(a.type)&&(Lt=a.stateNode,Ia=!1),li(t,e,a),Ol(a.stateNode),Lt=n,Ia=i;break;case 5:Gt||qn(a,e);case 6:if(n=Lt,i=Ia,Lt=null,li(t,e,a),Lt=n,Ia=i,Lt!==null)if(Ia)try{(Lt.nodeType===9?Lt.body:Lt.nodeName==="HTML"?Lt.ownerDocument.body:Lt).removeChild(a.stateNode)}catch(s){st(a,e,s)}else try{Lt.removeChild(a.stateNode)}catch(s){st(a,e,s)}break;case 18:Lt!==null&&(Ia?(t=Lt,Vy(t.nodeType===9?t.body:t.nodeName==="HTML"?t.ownerDocument.body:t,a.stateNode),go(t)):Vy(Lt,a.stateNode));break;case 4:n=Lt,i=Ia,Lt=a.stateNode.containerInfo,Ia=!0,li(t,e,a),Lt=n,Ia=i;break;case 0:case 11:case 14:case 15:vs(2,a,e),Gt||vs(4,a,e),li(t,e,a);break;case 1:Gt||(qn(a,e),n=a.stateNode,typeof n.componentWillUnmount=="function"&&WS(a,e,n)),li(t,e,a);break;case 21:li(t,e,a);break;case 22:Gt=(n=Gt)||a.memoizedState!==null,li(t,e,a),Gt=n;break;default:li(t,e,a)}}function jS(t,e){if(e.memoizedState===null&&(t=e.alternate,t!==null&&(t=t.memoizedState,t!==null))){t=t.dehydrated;try{go(t)}catch(a){st(e,e.return,a)}}}function $S(t,e){if(e.memoizedState===null&&(t=e.alternate,t!==null&&(t=t.memoizedState,t!==null&&(t=t.dehydrated,t!==null))))try{go(t)}catch(a){st(e,e.return,a)}}function NE(t){switch(t.tag){case 31:case 13:case 19:var e=t.stateNode;return e===null&&(e=t.stateNode=new Ty),e;case 22:return t=t.stateNode,e=t._retryCache,e===null&&(e=t._retryCache=new Ty),e;default:throw Error(Q(435,t.tag))}}function wf(t,e){var a=NE(t);e.forEach(function(n){if(!a.has(n)){a.add(n);var i=XE.bind(null,t,n);n.then(i,i)}})}function Aa(t,e){var a=e.deletions;if(a!==null)for(var n=0;n<a.length;n++){var i=a[n],s=t,r=e,o=r;e:for(;o!==null;){switch(o.tag){case 27:if(Ss(o.type)){Lt=o.stateNode,Ia=!1;break e}break;case 5:Lt=o.stateNode,Ia=!1;break e;case 3:case 4:Lt=o.stateNode.containerInfo,Ia=!0;break e}o=o.return}if(Lt===null)throw Error(Q(160));QS(s,r,i),Lt=null,Ia=!1,s=i.alternate,s!==null&&(s.return=null),i.return=null}if(e.subtreeFlags&13886)for(e=e.child;e!==null;)eM(e,t),e=e.sibling}var bn=null;function eM(t,e){var a=t.alternate,n=t.flags;switch(t.tag){case 0:case 11:case 14:case 15:Aa(e,t),Ta(t),n&4&&(vs(3,t,t.return),su(3,t),vs(5,t,t.return));break;case 1:Aa(e,t),Ta(t),n&512&&(Gt||a===null||qn(a,a.return)),n&64&&di&&(t=t.updateQueue,t!==null&&(n=t.callbacks,n!==null&&(a=t.shared.hiddenCallbacks,t.shared.hiddenCallbacks=a===null?n:a.concat(n))));break;case 26:var i=bn;if(Aa(e,t),Ta(t),n&512&&(Gt||a===null||qn(a,a.return)),n&4){var s=a!==null?a.memoizedState:null;if(n=t.memoizedState,a===null)if(n===null)if(t.stateNode===null){e:{n=t.type,a=t.memoizedProps,i=i.ownerDocument||i;t:switch(n){case"title":s=i.getElementsByTagName("title")[0],(!s||s[tu]||s[ra]||s.namespaceURI==="http://www.w3.org/2000/svg"||s.hasAttribute("itemprop"))&&(s=i.createElement(n),i.head.insertBefore(s,i.querySelector("head > title"))),ua(s,n,a),s[ra]=t,ta(s),n=s;break e;case"link":var r=Ky("link","href",i).get(n+(a.href||""));if(r){for(var o=0;o<r.length;o++)if(s=r[o],s.getAttribute("href")===(a.href==null||a.href===""?null:a.href)&&s.getAttribute("rel")===(a.rel==null?null:a.rel)&&s.getAttribute("title")===(a.title==null?null:a.title)&&s.getAttribute("crossorigin")===(a.crossOrigin==null?null:a.crossOrigin)){r.splice(o,1);break t}}s=i.createElement(n),ua(s,n,a),i.head.appendChild(s);break;case"meta":if(r=Ky("meta","content",i).get(n+(a.content||""))){for(o=0;o<r.length;o++)if(s=r[o],s.getAttribute("content")===(a.content==null?null:""+a.content)&&s.getAttribute("name")===(a.name==null?null:a.name)&&s.getAttribute("property")===(a.property==null?null:a.property)&&s.getAttribute("http-equiv")===(a.httpEquiv==null?null:a.httpEquiv)&&s.getAttribute("charset")===(a.charSet==null?null:a.charSet)){r.splice(o,1);break t}}s=i.createElement(n),ua(s,n,a),i.head.appendChild(s);break;default:throw Error(Q(468,n))}s[ra]=t,ta(s),n=s}t.stateNode=n}else Jy(i,t.type,t.stateNode);else t.stateNode=Zy(i,n,t.memoizedProps);else s!==n?(s===null?a.stateNode!==null&&(a=a.stateNode,a.parentNode.removeChild(a)):s.count--,n===null?Jy(i,t.type,t.stateNode):Zy(i,n,t.memoizedProps)):n===null&&t.stateNode!==null&&Qp(t,t.memoizedProps,a.memoizedProps)}break;case 27:Aa(e,t),Ta(t),n&512&&(Gt||a===null||qn(a,a.return)),a!==null&&n&4&&Qp(t,t.memoizedProps,a.memoizedProps);break;case 5:if(Aa(e,t),Ta(t),n&512&&(Gt||a===null||qn(a,a.return)),t.flags&32){i=t.stateNode;try{oo(i,"")}catch(v){st(t,t.return,v)}}n&4&&t.stateNode!=null&&(i=t.memoizedProps,Qp(t,i,a!==null?a.memoizedProps:i)),n&1024&&($p=!0);break;case 6:if(Aa(e,t),Ta(t),n&4){if(t.stateNode===null)throw Error(Q(162));n=t.memoizedProps,a=t.stateNode;try{a.nodeValue=n}catch(v){st(t,t.return,v)}}break;case 3:if(Zf=null,i=bn,bn=Sd(e.containerInfo),Aa(e,t),bn=i,Ta(t),n&4&&a!==null&&a.memoizedState.isDehydrated)try{go(e.containerInfo)}catch(v){st(t,t.return,v)}$p&&($p=!1,tM(t));break;case 4:n=bn,bn=Sd(t.stateNode.containerInfo),Aa(e,t),Ta(t),bn=n;break;case 12:Aa(e,t),Ta(t);break;case 31:Aa(e,t),Ta(t),n&4&&(n=t.updateQueue,n!==null&&(t.updateQueue=null,wf(t,n)));break;case 13:Aa(e,t),Ta(t),t.child.flags&8192&&t.memoizedState!==null!=(a!==null&&a.memoizedState!==null)&&(Nd=Wa()),n&4&&(n=t.updateQueue,n!==null&&(t.updateQueue=null,wf(t,n)));break;case 22:i=t.memoizedState!==null;var l=a!==null&&a.memoizedState!==null,u=di,d=Gt;if(di=u||i,Gt=d||l,Aa(e,t),Gt=d,di=u,Ta(t),n&8192)e:for(e=t.stateNode,e._visibility=i?e._visibility&-2:e._visibility|1,i&&(a===null||l||di||Gt||Vs(t)),a=null,e=t;;){if(e.tag===5||e.tag===26){if(a===null){l=a=e;try{if(s=l.stateNode,i)r=s.style,typeof r.setProperty=="function"?r.setProperty("display","none","important"):r.display="none";else{o=l.stateNode;var p=l.memoizedProps.style,c=p!=null&&p.hasOwnProperty("display")?p.display:null;o.style.display=c==null||typeof c=="boolean"?"":(""+c).trim()}}catch(v){st(l,l.return,v)}}}else if(e.tag===6){if(a===null){l=e;try{l.stateNode.nodeValue=i?"":l.memoizedProps}catch(v){st(l,l.return,v)}}}else if(e.tag===18){if(a===null){l=e;try{var h=l.stateNode;i?Gy(h,!0):Gy(l.stateNode,!1)}catch(v){st(l,l.return,v)}}}else if((e.tag!==22&&e.tag!==23||e.memoizedState===null||e===t)&&e.child!==null){e.child.return=e,e=e.child;continue}if(e===t)break e;for(;e.sibling===null;){if(e.return===null||e.return===t)break e;a===e&&(a=null),e=e.return}a===e&&(a=null),e.sibling.return=e.return,e=e.sibling}n&4&&(n=t.updateQueue,n!==null&&(a=n.retryQueue,a!==null&&(n.retryQueue=null,wf(t,a))));break;case 19:Aa(e,t),Ta(t),n&4&&(n=t.updateQueue,n!==null&&(t.updateQueue=null,wf(t,n)));break;case 30:break;case 21:break;default:Aa(e,t),Ta(t)}}function Ta(t){var e=t.flags;if(e&2){try{for(var a,n=t.return;n!==null;){if(YS(n)){a=n;break}n=n.return}if(a==null)throw Error(Q(160));switch(a.tag){case 27:var i=a.stateNode,s=jp(t);hd(t,s,i);break;case 5:var r=a.stateNode;a.flags&32&&(oo(r,""),a.flags&=-33);var o=jp(t);hd(t,o,r);break;case 3:case 4:var l=a.stateNode.containerInfo,u=jp(t);km(t,u,l);break;default:throw Error(Q(161))}}catch(d){st(t,t.return,d)}t.flags&=-3}e&4096&&(t.flags&=-4097)}function tM(t){if(t.subtreeFlags&1024)for(t=t.child;t!==null;){var e=t;tM(e),e.tag===5&&e.flags&1024&&e.stateNode.reset(),t=t.sibling}}function ui(t,e){if(e.subtreeFlags&8772)for(e=e.child;e!==null;)KS(t,e.alternate,e),e=e.sibling}function Vs(t){for(t=t.child;t!==null;){var e=t;switch(e.tag){case 0:case 11:case 14:case 15:vs(4,e,e.return),Vs(e);break;case 1:qn(e,e.return);var a=e.stateNode;typeof a.componentWillUnmount=="function"&&WS(e,e.return,a),Vs(e);break;case 27:Ol(e.stateNode);case 26:case 5:qn(e,e.return),Vs(e);break;case 22:e.memoizedState===null&&Vs(e);break;case 30:Vs(e);break;default:Vs(e)}t=t.sibling}}function ci(t,e,a){for(a=a&&(e.subtreeFlags&8772)!==0,e=e.child;e!==null;){var n=e.alternate,i=t,s=e,r=s.flags;switch(s.tag){case 0:case 11:case 15:ci(i,s,a),su(4,s);break;case 1:if(ci(i,s,a),n=s,i=n.stateNode,typeof i.componentDidMount=="function")try{i.componentDidMount()}catch(u){st(n,n.return,u)}if(n=s,i=n.updateQueue,i!==null){var o=n.stateNode;try{var l=i.shared.hiddenCallbacks;if(l!==null)for(i.shared.hiddenCallbacks=null,i=0;i<l.length;i++)j_(l[i],o)}catch(u){st(n,n.return,u)}}a&&r&64&&qS(s),Dl(s,s.return);break;case 27:ZS(s);case 26:case 5:ci(i,s,a),a&&n===null&&r&4&&XS(s),Dl(s,s.return);break;case 12:ci(i,s,a);break;case 31:ci(i,s,a),a&&r&4&&jS(i,s);break;case 13:ci(i,s,a),a&&r&4&&$S(i,s);break;case 22:s.memoizedState===null&&ci(i,s,a),Dl(s,s.return);break;case 30:break;default:ci(i,s,a)}e=e.sibling}}function zg(t,e){var a=null;t!==null&&t.memoizedState!==null&&t.memoizedState.cachePool!==null&&(a=t.memoizedState.cachePool.pool),t=null,e.memoizedState!==null&&e.memoizedState.cachePool!==null&&(t=e.memoizedState.cachePool.pool),t!==a&&(t!=null&&t.refCount++,a!=null&&nu(a))}function kg(t,e){t=null,e.alternate!==null&&(t=e.alternate.memoizedState.cache),e=e.memoizedState.cache,e!==t&&(e.refCount++,t!=null&&nu(t))}function Mn(t,e,a,n){if(e.subtreeFlags&10256)for(e=e.child;e!==null;)aM(t,e,a,n),e=e.sibling}function aM(t,e,a,n){var i=e.flags;switch(e.tag){case 0:case 11:case 15:Mn(t,e,a,n),i&2048&&su(9,e);break;case 1:Mn(t,e,a,n);break;case 3:Mn(t,e,a,n),i&2048&&(t=null,e.alternate!==null&&(t=e.alternate.memoizedState.cache),e=e.memoizedState.cache,e!==t&&(e.refCount++,t!=null&&nu(t)));break;case 12:if(i&2048){Mn(t,e,a,n),t=e.stateNode;try{var s=e.memoizedProps,r=s.id,o=s.onPostCommit;typeof o=="function"&&o(r,e.alternate===null?"mount":"update",t.passiveEffectDuration,-0)}catch(l){st(e,e.return,l)}}else Mn(t,e,a,n);break;case 31:Mn(t,e,a,n);break;case 13:Mn(t,e,a,n);break;case 23:break;case 22:s=e.stateNode,r=e.alternate,e.memoizedState!==null?s._visibility&2?Mn(t,e,a,n):Pl(t,e):s._visibility&2?Mn(t,e,a,n):(s._visibility|=2,Fr(t,e,a,n,(e.subtreeFlags&10256)!==0||!1)),i&2048&&zg(r,e);break;case 24:Mn(t,e,a,n),i&2048&&kg(e.alternate,e);break;default:Mn(t,e,a,n)}}function Fr(t,e,a,n,i){for(i=i&&((e.subtreeFlags&10256)!==0||!1),e=e.child;e!==null;){var s=t,r=e,o=a,l=n,u=r.flags;switch(r.tag){case 0:case 11:case 15:Fr(s,r,o,l,i),su(8,r);break;case 23:break;case 22:var d=r.stateNode;r.memoizedState!==null?d._visibility&2?Fr(s,r,o,l,i):Pl(s,r):(d._visibility|=2,Fr(s,r,o,l,i)),i&&u&2048&&zg(r.alternate,r);break;case 24:Fr(s,r,o,l,i),i&&u&2048&&kg(r.alternate,r);break;default:Fr(s,r,o,l,i)}e=e.sibling}}function Pl(t,e){if(e.subtreeFlags&10256)for(e=e.child;e!==null;){var a=t,n=e,i=n.flags;switch(n.tag){case 22:Pl(a,n),i&2048&&zg(n.alternate,n);break;case 24:Pl(a,n),i&2048&&kg(n.alternate,n);break;default:Pl(a,n)}e=e.sibling}}var bl=8192;function Nr(t,e,a){if(t.subtreeFlags&bl)for(t=t.child;t!==null;)nM(t,e,a),t=t.sibling}function nM(t,e,a){switch(t.tag){case 26:Nr(t,e,a),t.flags&bl&&t.memoizedState!==null&&Sw(a,bn,t.memoizedState,t.memoizedProps);break;case 5:Nr(t,e,a);break;case 3:case 4:var n=bn;bn=Sd(t.stateNode.containerInfo),Nr(t,e,a),bn=n;break;case 22:t.memoizedState===null&&(n=t.alternate,n!==null&&n.memoizedState!==null?(n=bl,bl=16777216,Nr(t,e,a),bl=n):Nr(t,e,a));break;default:Nr(t,e,a)}}function iM(t){var e=t.alternate;if(e!==null&&(t=e.child,t!==null)){e.child=null;do e=t.sibling,t.sibling=null,t=e;while(t!==null)}}function gl(t){var e=t.deletions;if((t.flags&16)!==0){if(e!==null)for(var a=0;a<e.length;a++){var n=e[a];ea=n,rM(n,t)}iM(t)}if(t.subtreeFlags&10256)for(t=t.child;t!==null;)sM(t),t=t.sibling}function sM(t){switch(t.tag){case 0:case 11:case 15:gl(t),t.flags&2048&&vs(9,t,t.return);break;case 3:gl(t);break;case 12:gl(t);break;case 22:var e=t.stateNode;t.memoizedState!==null&&e._visibility&2&&(t.return===null||t.return.tag!==13)?(e._visibility&=-3,Xf(t)):gl(t);break;default:gl(t)}}function Xf(t){var e=t.deletions;if((t.flags&16)!==0){if(e!==null)for(var a=0;a<e.length;a++){var n=e[a];ea=n,rM(n,t)}iM(t)}for(t=t.child;t!==null;){switch(e=t,e.tag){case 0:case 11:case 15:vs(8,e,e.return),Xf(e);break;case 22:a=e.stateNode,a._visibility&2&&(a._visibility&=-3,Xf(e));break;default:Xf(e)}t=t.sibling}}function rM(t,e){for(;ea!==null;){var a=ea;switch(a.tag){case 0:case 11:case 15:vs(8,a,e);break;case 23:case 22:if(a.memoizedState!==null&&a.memoizedState.cachePool!==null){var n=a.memoizedState.cachePool.pool;n!=null&&n.refCount++}break;case 24:nu(a.memoizedState.cache)}if(n=a.child,n!==null)n.return=a,ea=n;else e:for(a=t;ea!==null;){n=ea;var i=n.sibling,s=n.return;if(JS(n),n===a){ea=null;break e}if(i!==null){i.return=s,ea=i;break e}ea=s}}}var FE={getCacheForType:function(t){var e=la(qt),a=e.data.get(t);return a===void 0&&(a=t(),e.data.set(t,a)),a},cacheSignal:function(){return la(qt).controller.signal}},zE=typeof WeakMap=="function"?WeakMap:Map,et=0,dt=null,He=null,We=0,it=0,Ha=null,is=!1,So=!1,Hg=!1,bi=0,Dt=0,ys=0,Ys=0,Vg=0,qa=0,fo=0,Ul=null,Ea=null,Hm=!1,Nd=0,oM=0,pd=1/0,md=null,fs=null,Kt=0,ds=null,ho=null,vi=0,Vm=0,Gm=null,lM=null,Bl=0,qm=null;function Za(){return(et&2)!==0&&We!==0?We&-We:we.T!==null?qg():x_()}function uM(){if(qa===0)if((We&536870912)===0||Ye){var t=_f;_f<<=1,(_f&3932160)===0&&(_f=262144),qa=t}else qa=536870912;return t=Ja.current,t!==null&&(t.flags|=32),qa}function wa(t,e,a){(t===dt&&(it===2||it===9)||t.cancelPendingCommit!==null)&&(po(t,0),ss(t,We,qa,!1)),eu(t,a),((et&2)===0||t!==dt)&&(t===dt&&((et&2)===0&&(Ys|=a),Dt===4&&ss(t,We,qa,!1)),Yn(t))}function cM(t,e,a){if((et&6)!==0)throw Error(Q(327));var n=!a&&(e&127)===0&&(e&t.expiredLanes)===0||$l(t,e),i=n?VE(t,e):em(t,e,!0),s=n;do{if(i===0){So&&!n&&ss(t,e,0,!1);break}else{if(a=t.current.alternate,s&&!kE(a)){i=em(t,e,!1),s=!1;continue}if(i===2){if(s=e,t.errorRecoveryDisabledLanes&s)var r=0;else r=t.pendingLanes&-536870913,r=r!==0?r:r&536870912?536870912:0;if(r!==0){e=r;e:{var o=t;i=Ul;var l=o.current.memoizedState.isDehydrated;if(l&&(po(o,r).flags|=256),r=em(o,r,!1),r!==2){if(Hg&&!l){o.errorRecoveryDisabledLanes|=s,Ys|=s,i=4;break e}s=Ea,Ea=i,s!==null&&(Ea===null?Ea=s:Ea.push.apply(Ea,s))}i=r}if(s=!1,i!==2)continue}}if(i===1){po(t,0),ss(t,e,0,!0);break}e:{switch(n=t,s=i,s){case 0:case 1:throw Error(Q(345));case 4:if((e&4194048)!==e)break;case 6:ss(n,e,qa,!is);break e;case 2:Ea=null;break;case 3:case 5:break;default:throw Error(Q(329))}if((e&62914560)===e&&(i=Nd+300-Wa(),10<i)){if(ss(n,e,qa,!is),Ad(n,0,!0)!==0)break e;vi=e,n.timeoutHandle=wM(Iy.bind(null,n,a,Ea,md,Hm,e,qa,Ys,fo,is,s,"Throttled",-0,0),i);break e}Iy(n,a,Ea,md,Hm,e,qa,Ys,fo,is,s,null,-0,0)}}break}while(!0);Yn(t)}function Iy(t,e,a,n,i,s,r,o,l,u,d,p,c,h){if(t.timeoutHandle=-1,p=e.subtreeFlags,p&8192||(p&16785408)===16785408){p={stylesheets:null,count:0,imgCount:0,imgBytes:0,suspenseyImages:[],waitingForImages:!0,waitingForViewTransition:!1,unsuspend:pi},nM(e,s,p);var v=(s&62914560)===s?Nd-Wa():(s&4194048)===s?oM-Wa():0;if(v=Mw(p,v),v!==null){vi=s,t.cancelPendingCommit=v(wy.bind(null,t,e,s,a,n,i,r,o,l,d,p,null,c,h)),ss(t,s,r,!u);return}}wy(t,e,s,a,n,i,r,o,l)}function kE(t){for(var e=t;;){var a=e.tag;if((a===0||a===11||a===15)&&e.flags&16384&&(a=e.updateQueue,a!==null&&(a=a.stores,a!==null)))for(var n=0;n<a.length;n++){var i=a[n],s=i.getSnapshot;i=i.value;try{if(!Ka(s(),i))return!1}catch{return!1}}if(a=e.child,e.subtreeFlags&16384&&a!==null)a.return=e,e=a;else{if(e===t)break;for(;e.sibling===null;){if(e.return===null||e.return===t)return!0;e=e.return}e.sibling.return=e.return,e=e.sibling}}return!0}function ss(t,e,a,n){e&=~Vg,e&=~Ys,t.suspendedLanes|=e,t.pingedLanes&=~e,n&&(t.warmLanes|=e),n=t.expirationTimes;for(var i=e;0<i;){var s=31-Ya(i),r=1<<s;n[s]=-1,i&=~r}a!==0&&p_(t,a,e)}function Fd(){return(et&6)===0?(ru(0,!1),!1):!0}function Gg(){if(He!==null){if(it===0)var t=He.return;else t=He,mi=nr=null,Ig(t),ao=null,Gl=0,t=He;for(;t!==null;)GS(t.alternate,t),t=t.return;He=null}}function po(t,e){var a=t.timeoutHandle;a!==-1&&(t.timeoutHandle=-1,iw(a)),a=t.cancelPendingCommit,a!==null&&(t.cancelPendingCommit=null,a()),vi=0,Gg(),dt=t,He=a=gi(t.current,null),We=e,it=0,Ha=null,is=!1,So=$l(t,e),Hg=!1,fo=qa=Vg=Ys=ys=Dt=0,Ea=Ul=null,Hm=!1,(e&8)!==0&&(e|=e&32);var n=t.entangledLanes;if(n!==0)for(t=t.entanglements,n&=e;0<n;){var i=31-Ya(n),s=1<<i;e|=t[i],n&=~s}return bi=e,wd(),a}function fM(t,e){Ne=null,we.H=Wl,e===_o||e===Dd?(e=ry(),it=3):e===Sg?(e=ry(),it=4):it=e===Ng?8:e!==null&&typeof e=="object"&&typeof e.then=="function"?6:1,Ha=e,He===null&&(Dt=1,fd(t,un(e,t.current)))}function dM(){var t=Ja.current;return t===null?!0:(We&4194048)===We?fn===null:(We&62914560)===We||(We&536870912)!==0?t===fn:!1}function hM(){var t=we.H;return we.H=Wl,t===null?Wl:t}function pM(){var t=we.A;return we.A=FE,t}function gd(){Dt=4,is||(We&4194048)!==We&&Ja.current!==null||(So=!0),(ys&134217727)===0&&(Ys&134217727)===0||dt===null||ss(dt,We,qa,!1)}function em(t,e,a){var n=et;et|=2;var i=hM(),s=pM();(dt!==t||We!==e)&&(md=null,po(t,e)),e=!1;var r=Dt;e:do try{if(it!==0&&He!==null){var o=He,l=Ha;switch(it){case 8:Gg(),r=6;break e;case 3:case 2:case 9:case 6:Ja.current===null&&(e=!0);var u=it;if(it=0,Ha=null,Qr(t,o,l,u),a&&So){r=0;break e}break;default:u=it,it=0,Ha=null,Qr(t,o,l,u)}}HE(),r=Dt;break}catch(d){fM(t,d)}while(!0);return e&&t.shellSuspendCounter++,mi=nr=null,et=n,we.H=i,we.A=s,He===null&&(dt=null,We=0,wd()),r}function HE(){for(;He!==null;)mM(He)}function VE(t,e){var a=et;et|=2;var n=hM(),i=pM();dt!==t||We!==e?(md=null,pd=Wa()+500,po(t,e)):So=$l(t,e);e:do try{if(it!==0&&He!==null){e=He;var s=Ha;t:switch(it){case 1:it=0,Ha=null,Qr(t,e,s,1);break;case 2:case 9:if(sy(s)){it=0,Ha=null,Ey(e);break}e=function(){it!==2&&it!==9||dt!==t||(it=7),Yn(t)},s.then(e,e);break e;case 3:it=7;break e;case 4:it=5;break e;case 7:sy(s)?(it=0,Ha=null,Ey(e)):(it=0,Ha=null,Qr(t,e,s,7));break;case 5:var r=null;switch(He.tag){case 26:r=He.memoizedState;case 5:case 27:var o=He;if(r?BM(r):o.stateNode.complete){it=0,Ha=null;var l=o.sibling;if(l!==null)He=l;else{var u=o.return;u!==null?(He=u,zd(u)):He=null}break t}}it=0,Ha=null,Qr(t,e,s,5);break;case 6:it=0,Ha=null,Qr(t,e,s,6);break;case 8:Gg(),Dt=6;break e;default:throw Error(Q(462))}}GE();break}catch(d){fM(t,d)}while(!0);return mi=nr=null,we.H=n,we.A=i,et=a,He!==null?0:(dt=null,We=0,wd(),Dt)}function GE(){for(;He!==null&&!dI();)mM(He)}function mM(t){var e=VS(t.alternate,t,bi);t.memoizedProps=t.pendingProps,e===null?zd(t):He=e}function Ey(t){var e=t,a=e.alternate;switch(e.tag){case 15:case 0:e=My(a,e,e.pendingProps,e.type,void 0,We);break;case 11:e=My(a,e,e.pendingProps,e.type.render,e.ref,We);break;case 5:Ig(e);default:GS(a,e),e=He=G_(e,bi),e=VS(a,e,bi)}t.memoizedProps=t.pendingProps,e===null?zd(t):He=e}function Qr(t,e,a,n){mi=nr=null,Ig(e),ao=null,Gl=0;var i=e.return;try{if(RE(t,i,e,a,We)){Dt=1,fd(t,un(a,t.current)),He=null;return}}catch(s){if(i!==null)throw He=i,s;Dt=1,fd(t,un(a,t.current)),He=null;return}e.flags&32768?(Ye||n===1?t=!0:So||(We&536870912)!==0?t=!1:(is=t=!0,(n===2||n===9||n===3||n===6)&&(n=Ja.current,n!==null&&n.tag===13&&(n.flags|=16384))),gM(e,t)):zd(e)}function zd(t){var e=t;do{if((e.flags&32768)!==0){gM(e,is);return}t=e.return;var a=UE(e.alternate,e,bi);if(a!==null){He=a;return}if(e=e.sibling,e!==null){He=e;return}He=e=t}while(e!==null);Dt===0&&(Dt=5)}function gM(t,e){do{var a=BE(t.alternate,t);if(a!==null){a.flags&=32767,He=a;return}if(a=t.return,a!==null&&(a.flags|=32768,a.subtreeFlags=0,a.deletions=null),!e&&(t=t.sibling,t!==null)){He=t;return}He=t=a}while(t!==null);Dt=6,He=null}function wy(t,e,a,n,i,s,r,o,l){t.cancelPendingCommit=null;do kd();while(Kt!==0);if((et&6)!==0)throw Error(Q(327));if(e!==null){if(e===t.current)throw Error(Q(177));if(s=e.lanes|e.childLanes,s|=pg,MI(t,a,s,r,o,l),t===dt&&(He=dt=null,We=0),ho=e,ds=t,vi=a,Vm=s,Gm=i,lM=n,(e.subtreeFlags&10256)!==0||(e.flags&10256)!==0?(t.callbackNode=null,t.callbackPriority=0,YE(ed,function(){return SM(),null})):(t.callbackNode=null,t.callbackPriority=0),n=(e.flags&13878)!==0,(e.subtreeFlags&13878)!==0||n){n=we.T,we.T=null,i=tt.p,tt.p=2,r=et,et|=4;try{OE(t,e,a)}finally{et=r,tt.p=i,we.T=n}}Kt=1,xM(),vM(),yM()}}function xM(){if(Kt===1){Kt=0;var t=ds,e=ho,a=(e.flags&13878)!==0;if((e.subtreeFlags&13878)!==0||a){a=we.T,we.T=null;var n=tt.p;tt.p=2;var i=et;et|=4;try{eM(e,t);var s=Zm,r=B_(t.containerInfo),o=s.focusedElem,l=s.selectionRange;if(r!==o&&o&&o.ownerDocument&&U_(o.ownerDocument.documentElement,o)){if(l!==null&&hg(o)){var u=l.start,d=l.end;if(d===void 0&&(d=u),"selectionStart"in o)o.selectionStart=u,o.selectionEnd=Math.min(d,o.value.length);else{var p=o.ownerDocument||document,c=p&&p.defaultView||window;if(c.getSelection){var h=c.getSelection(),v=o.textContent.length,b=Math.min(l.start,v),m=l.end===void 0?b:Math.min(l.end,v);!h.extend&&b>m&&(r=m,m=b,b=r);var f=jv(o,b),x=jv(o,m);if(f&&x&&(h.rangeCount!==1||h.anchorNode!==f.node||h.anchorOffset!==f.offset||h.focusNode!==x.node||h.focusOffset!==x.offset)){var S=p.createRange();S.setStart(f.node,f.offset),h.removeAllRanges(),b>m?(h.addRange(S),h.extend(x.node,x.offset)):(S.setEnd(x.node,x.offset),h.addRange(S))}}}}for(p=[],h=o;h=h.parentNode;)h.nodeType===1&&p.push({element:h,left:h.scrollLeft,top:h.scrollTop});for(typeof o.focus=="function"&&o.focus(),o=0;o<p.length;o++){var _=p[o];_.element.scrollLeft=_.left,_.element.scrollTop=_.top}}Cd=!!Ym,Zm=Ym=null}finally{et=i,tt.p=n,we.T=a}}t.current=e,Kt=2}}function vM(){if(Kt===2){Kt=0;var t=ds,e=ho,a=(e.flags&8772)!==0;if((e.subtreeFlags&8772)!==0||a){a=we.T,we.T=null;var n=tt.p;tt.p=2;var i=et;et|=4;try{KS(t,e.alternate,e)}finally{et=i,tt.p=n,we.T=a}}Kt=3}}function yM(){if(Kt===4||Kt===3){Kt=0,hI();var t=ds,e=ho,a=vi,n=lM;(e.subtreeFlags&10256)!==0||(e.flags&10256)!==0?Kt=5:(Kt=0,ho=ds=null,_M(t,t.pendingLanes));var i=t.pendingLanes;if(i===0&&(fs=null),rg(a),e=e.stateNode,Xa&&typeof Xa.onCommitFiberRoot=="function")try{Xa.onCommitFiberRoot(jl,e,void 0,(e.current.flags&128)===128)}catch{}if(n!==null){e=we.T,i=tt.p,tt.p=2,we.T=null;try{for(var s=t.onRecoverableError,r=0;r<n.length;r++){var o=n[r];s(o.value,{componentStack:o.stack})}}finally{we.T=e,tt.p=i}}(vi&3)!==0&&kd(),Yn(t),i=t.pendingLanes,(a&261930)!==0&&(i&42)!==0?t===qm?Bl++:(Bl=0,qm=t):Bl=0,ru(0,!1)}}function _M(t,e){(t.pooledCacheLanes&=e)===0&&(e=t.pooledCache,e!=null&&(t.pooledCache=null,nu(e)))}function kd(){return xM(),vM(),yM(),SM()}function SM(){if(Kt!==5)return!1;var t=ds,e=Vm;Vm=0;var a=rg(vi),n=we.T,i=tt.p;try{tt.p=32>a?32:a,we.T=null,a=Gm,Gm=null;var s=ds,r=vi;if(Kt=0,ho=ds=null,vi=0,(et&6)!==0)throw Error(Q(331));var o=et;if(et|=4,sM(s.current),aM(s,s.current,r,a),et=o,ru(0,!1),Xa&&typeof Xa.onPostCommitFiberRoot=="function")try{Xa.onPostCommitFiberRoot(jl,s)}catch{}return!0}finally{tt.p=i,we.T=n,_M(t,e)}}function Ry(t,e,a){e=un(a,e),e=Nm(t.stateNode,e,2),t=cs(t,e,2),t!==null&&(eu(t,2),Yn(t))}function st(t,e,a){if(t.tag===3)Ry(t,t,a);else for(;e!==null;){if(e.tag===3){Ry(e,t,a);break}else if(e.tag===1){var n=e.stateNode;if(typeof e.type.getDerivedStateFromError=="function"||typeof n.componentDidCatch=="function"&&(fs===null||!fs.has(n))){t=un(a,t),a=OS(2),n=cs(e,a,2),n!==null&&(NS(a,n,e,t),eu(n,2),Yn(n));break}}e=e.return}}function tm(t,e,a){var n=t.pingCache;if(n===null){n=t.pingCache=new zE;var i=new Set;n.set(e,i)}else i=n.get(e),i===void 0&&(i=new Set,n.set(e,i));i.has(a)||(Hg=!0,i.add(a),t=qE.bind(null,t,e,a),e.then(t,t))}function qE(t,e,a){var n=t.pingCache;n!==null&&n.delete(e),t.pingedLanes|=t.suspendedLanes&a,t.warmLanes&=~a,dt===t&&(We&a)===a&&(Dt===4||Dt===3&&(We&62914560)===We&&300>Wa()-Nd?(et&2)===0&&po(t,0):Vg|=a,fo===We&&(fo=0)),Yn(t)}function MM(t,e){e===0&&(e=h_()),t=ar(t,e),t!==null&&(eu(t,e),Yn(t))}function WE(t){var e=t.memoizedState,a=0;e!==null&&(a=e.retryLane),MM(t,a)}function XE(t,e){var a=0;switch(t.tag){case 31:case 13:var n=t.stateNode,i=t.memoizedState;i!==null&&(a=i.retryLane);break;case 19:n=t.stateNode;break;case 22:n=t.stateNode._retryCache;break;default:throw Error(Q(314))}n!==null&&n.delete(e),MM(t,a)}function YE(t,e){return ig(t,e)}var xd=null,zr=null,Wm=!1,vd=!1,am=!1,rs=0;function Yn(t){t!==zr&&t.next===null&&(zr===null?xd=zr=t:zr=zr.next=t),vd=!0,Wm||(Wm=!0,KE())}function ru(t,e){if(!am&&vd){am=!0;do for(var a=!1,n=xd;n!==null;){if(!e)if(t!==0){var i=n.pendingLanes;if(i===0)var s=0;else{var r=n.suspendedLanes,o=n.pingedLanes;s=(1<<31-Ya(42|t)+1)-1,s&=i&~(r&~o),s=s&201326741?s&201326741|1:s?s|2:0}s!==0&&(a=!0,Dy(n,s))}else s=We,s=Ad(n,n===dt?s:0,n.cancelPendingCommit!==null||n.timeoutHandle!==-1),(s&3)===0||$l(n,s)||(a=!0,Dy(n,s));n=n.next}while(a);am=!1}}function ZE(){bM()}function bM(){vd=Wm=!1;var t=0;rs!==0&&nw()&&(t=rs);for(var e=Wa(),a=null,n=xd;n!==null;){var i=n.next,s=CM(n,e);s===0?(n.next=null,a===null?xd=i:a.next=i,i===null&&(zr=a)):(a=n,(t!==0||(s&3)!==0)&&(vd=!0)),n=i}Kt!==0&&Kt!==5||ru(t,!1),rs!==0&&(rs=0)}function CM(t,e){for(var a=t.suspendedLanes,n=t.pingedLanes,i=t.expirationTimes,s=t.pendingLanes&-62914561;0<s;){var r=31-Ya(s),o=1<<r,l=i[r];l===-1?((o&a)===0||(o&n)!==0)&&(i[r]=SI(o,e)):l<=e&&(t.expiredLanes|=o),s&=~o}if(e=dt,a=We,a=Ad(t,t===e?a:0,t.cancelPendingCommit!==null||t.timeoutHandle!==-1),n=t.callbackNode,a===0||t===e&&(it===2||it===9)||t.cancelPendingCommit!==null)return n!==null&&n!==null&&Rp(n),t.callbackNode=null,t.callbackPriority=0;if((a&3)===0||$l(t,a)){if(e=a&-a,e===t.callbackPriority)return e;switch(n!==null&&Rp(n),rg(a)){case 2:case 8:a=f_;break;case 32:a=ed;break;case 268435456:a=d_;break;default:a=ed}return n=LM.bind(null,t),a=ig(a,n),t.callbackPriority=e,t.callbackNode=a,e}return n!==null&&n!==null&&Rp(n),t.callbackPriority=2,t.callbackNode=null,2}function LM(t,e){if(Kt!==0&&Kt!==5)return t.callbackNode=null,t.callbackPriority=0,null;var a=t.callbackNode;if(kd()&&t.callbackNode!==a)return null;var n=We;return n=Ad(t,t===dt?n:0,t.cancelPendingCommit!==null||t.timeoutHandle!==-1),n===0?null:(cM(t,n,e),CM(t,Wa()),t.callbackNode!=null&&t.callbackNode===a?LM.bind(null,t):null)}function Dy(t,e){if(kd())return null;cM(t,e,!0)}function KE(){sw(function(){(et&6)!==0?ig(c_,ZE):bM()})}function qg(){if(rs===0){var t=lo;t===0&&(t=yf,yf<<=1,(yf&261888)===0&&(yf=256)),rs=t}return rs}function Py(t){return t==null||typeof t=="symbol"||typeof t=="boolean"?null:typeof t=="function"?t:Nf(""+t)}function Uy(t,e){var a=e.ownerDocument.createElement("input");return a.name=e.name,a.value=e.value,t.id&&a.setAttribute("form",t.id),e.parentNode.insertBefore(a,e),t=new FormData(t),a.parentNode.removeChild(a),t}function JE(t,e,a,n,i){if(e==="submit"&&a&&a.stateNode===i){var s=Py((i[Ra]||null).action),r=n.submitter;r&&(e=(e=r[Ra]||null)?Py(e.formAction):r.getAttribute("formAction"),e!==null&&(s=e,r=null));var o=new Td("action","action",null,n,i);t.push({event:o,listeners:[{instance:null,listener:function(){if(n.defaultPrevented){if(rs!==0){var l=r?Uy(i,r):new FormData(i);Bm(a,{pending:!0,data:l,method:i.method,action:s},null,l)}}else typeof s=="function"&&(o.preventDefault(),l=r?Uy(i,r):new FormData(i),Bm(a,{pending:!0,data:l,method:i.method,action:s},s,l))},currentTarget:i}]})}}for(Rf=0;Rf<bm.length;Rf++)Df=bm[Rf],By=Df.toLowerCase(),Oy=Df[0].toUpperCase()+Df.slice(1),Cn(By,"on"+Oy);var Df,By,Oy,Rf;Cn(N_,"onAnimationEnd");Cn(F_,"onAnimationIteration");Cn(z_,"onAnimationStart");Cn("dblclick","onDoubleClick");Cn("focusin","onFocus");Cn("focusout","onBlur");Cn(pE,"onTransitionRun");Cn(mE,"onTransitionStart");Cn(gE,"onTransitionCancel");Cn(k_,"onTransitionEnd");ro("onMouseEnter",["mouseout","mouseover"]);ro("onMouseLeave",["mouseout","mouseover"]);ro("onPointerEnter",["pointerout","pointerover"]);ro("onPointerLeave",["pointerout","pointerover"]);$s("onChange","change click focusin focusout input keydown keyup selectionchange".split(" "));$s("onSelect","focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(" "));$s("onBeforeInput",["compositionend","keypress","textInput","paste"]);$s("onCompositionEnd","compositionend focusout keydown keypress keyup mousedown".split(" "));$s("onCompositionStart","compositionstart focusout keydown keypress keyup mousedown".split(" "));$s("onCompositionUpdate","compositionupdate focusout keydown keypress keyup mousedown".split(" "));var Xl="abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(" "),QE=new Set("beforetoggle cancel close invalid load scroll scrollend toggle".split(" ").concat(Xl));function AM(t,e){e=(e&4)!==0;for(var a=0;a<t.length;a++){var n=t[a],i=n.event;n=n.listeners;e:{var s=void 0;if(e)for(var r=n.length-1;0<=r;r--){var o=n[r],l=o.instance,u=o.currentTarget;if(o=o.listener,l!==s&&i.isPropagationStopped())break e;s=o,i.currentTarget=u;try{s(i)}catch(d){ad(d)}i.currentTarget=null,s=l}else for(r=0;r<n.length;r++){if(o=n[r],l=o.instance,u=o.currentTarget,o=o.listener,l!==s&&i.isPropagationStopped())break e;s=o,i.currentTarget=u;try{s(i)}catch(d){ad(d)}i.currentTarget=null,s=l}}}}function ke(t,e){var a=e[mm];a===void 0&&(a=e[mm]=new Set);var n=t+"__bubble";a.has(n)||(TM(e,t,2,!1),a.add(n))}function nm(t,e,a){var n=0;e&&(n|=4),TM(a,t,n,e)}var Pf="_reactListening"+Math.random().toString(36).slice(2);function Wg(t){if(!t[Pf]){t[Pf]=!0,v_.forEach(function(a){a!=="selectionchange"&&(QE.has(a)||nm(a,!1,t),nm(a,!0,t))});var e=t.nodeType===9?t:t.ownerDocument;e===null||e[Pf]||(e[Pf]=!0,nm("selectionchange",!1,e))}}function TM(t,e,a,n){switch(kM(e)){case 2:var i=Lw;break;case 8:i=Aw;break;default:i=Kg}a=i.bind(null,e,a,t),i=void 0,!_m||e!=="touchstart"&&e!=="touchmove"&&e!=="wheel"||(i=!0),n?i!==void 0?t.addEventListener(e,a,{capture:!0,passive:i}):t.addEventListener(e,a,!0):i!==void 0?t.addEventListener(e,a,{passive:i}):t.addEventListener(e,a,!1)}function im(t,e,a,n,i){var s=n;if((e&1)===0&&(e&2)===0&&n!==null)e:for(;;){if(n===null)return;var r=n.tag;if(r===3||r===4){var o=n.stateNode.containerInfo;if(o===i)break;if(r===4)for(r=n.return;r!==null;){var l=r.tag;if((l===3||l===4)&&r.stateNode.containerInfo===i)return;r=r.return}for(;o!==null;){if(r=Vr(o),r===null)return;if(l=r.tag,l===5||l===6||l===26||l===27){n=s=r;continue e}o=o.parentNode}}n=n.return}A_(function(){var u=s,d=ug(a),p=[];e:{var c=H_.get(t);if(c!==void 0){var h=Td,v=t;switch(t){case"keypress":if(zf(a)===0)break e;case"keydown":case"keyup":h=XI;break;case"focusin":v="focus",h=Op;break;case"focusout":v="blur",h=Op;break;case"beforeblur":case"afterblur":h=Op;break;case"click":if(a.button===2)break e;case"auxclick":case"dblclick":case"mousedown":case"mousemove":case"mouseup":case"mouseout":case"mouseover":case"contextmenu":h=Gv;break;case"drag":case"dragend":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"dragstart":case"drop":h=UI;break;case"touchcancel":case"touchend":case"touchmove":case"touchstart":h=KI;break;case N_:case F_:case z_:h=NI;break;case k_:h=QI;break;case"scroll":case"scrollend":h=DI;break;case"wheel":h=$I;break;case"copy":case"cut":case"paste":h=zI;break;case"gotpointercapture":case"lostpointercapture":case"pointercancel":case"pointerdown":case"pointermove":case"pointerout":case"pointerover":case"pointerup":h=Wv;break;case"toggle":case"beforetoggle":h=tE}var b=(e&4)!==0,m=!b&&(t==="scroll"||t==="scrollend"),f=b?c!==null?c+"Capture":null:c;b=[];for(var x=u,S;x!==null;){var _=x;if(S=_.stateNode,_=_.tag,_!==5&&_!==26&&_!==27||S===null||f===null||(_=Fl(x,f),_!=null&&b.push(Yl(x,_,S))),m)break;x=x.return}0<b.length&&(c=new h(c,v,null,a,d),p.push({event:c,listeners:b}))}}if((e&7)===0){e:{if(c=t==="mouseover"||t==="pointerover",h=t==="mouseout"||t==="pointerout",c&&a!==ym&&(v=a.relatedTarget||a.fromElement)&&(Vr(v)||v[xo]))break e;if((h||c)&&(c=d.window===d?d:(c=d.ownerDocument)?c.defaultView||c.parentWindow:window,h?(v=a.relatedTarget||a.toElement,h=u,v=v?Vr(v):null,v!==null&&(m=Ql(v),b=v.tag,v!==m||b!==5&&b!==27&&b!==6)&&(v=null)):(h=null,v=u),h!==v)){if(b=Gv,_="onMouseLeave",f="onMouseEnter",x="mouse",(t==="pointerout"||t==="pointerover")&&(b=Wv,_="onPointerLeave",f="onPointerEnter",x="pointer"),m=h==null?c:Sl(h),S=v==null?c:Sl(v),c=new b(_,x+"leave",h,a,d),c.target=m,c.relatedTarget=S,_=null,Vr(d)===u&&(b=new b(f,x+"enter",v,a,d),b.target=S,b.relatedTarget=m,_=b),m=_,h&&v)t:{for(b=jE,f=h,x=v,S=0,_=f;_;_=b(_))S++;_=0;for(var L=x;L;L=b(L))_++;for(;0<S-_;)f=b(f),S--;for(;0<_-S;)x=b(x),_--;for(;S--;){if(f===x||x!==null&&f===x.alternate){b=f;break t}f=b(f),x=b(x)}b=null}else b=null;h!==null&&Ny(p,c,h,b,!1),v!==null&&m!==null&&Ny(p,m,v,b,!0)}}e:{if(c=u?Sl(u):window,h=c.nodeName&&c.nodeName.toLowerCase(),h==="select"||h==="input"&&c.type==="file")var C=Kv;else if(Zv(c))if(D_)C=fE;else{C=uE;var T=lE}else h=c.nodeName,!h||h.toLowerCase()!=="input"||c.type!=="checkbox"&&c.type!=="radio"?u&&lg(u.elementType)&&(C=Kv):C=cE;if(C&&(C=C(t,u))){R_(p,C,a,d);break e}T&&T(t,c,u),t==="focusout"&&u&&c.type==="number"&&u.memoizedProps.value!=null&&vm(c,"number",c.value)}switch(T=u?Sl(u):window,t){case"focusin":(Zv(T)||T.contentEditable==="true")&&(Wr=T,Sm=u,Al=null);break;case"focusout":Al=Sm=Wr=null;break;case"mousedown":Mm=!0;break;case"contextmenu":case"mouseup":case"dragend":Mm=!1,$v(p,a,d);break;case"selectionchange":if(hE)break;case"keydown":case"keyup":$v(p,a,d)}var y;if(dg)e:{switch(t){case"compositionstart":var A="onCompositionStart";break e;case"compositionend":A="onCompositionEnd";break e;case"compositionupdate":A="onCompositionUpdate";break e}A=void 0}else qr?E_(t,a)&&(A="onCompositionEnd"):t==="keydown"&&a.keyCode===229&&(A="onCompositionStart");A&&(I_&&a.locale!=="ko"&&(qr||A!=="onCompositionStart"?A==="onCompositionEnd"&&qr&&(y=T_()):(ns=d,cg="value"in ns?ns.value:ns.textContent,qr=!0)),T=yd(u,A),0<T.length&&(A=new qv(A,t,null,a,d),p.push({event:A,listeners:T}),y?A.data=y:(y=w_(a),y!==null&&(A.data=y)))),(y=nE?iE(t,a):sE(t,a))&&(A=yd(u,"onBeforeInput"),0<A.length&&(T=new qv("onBeforeInput","beforeinput",null,a,d),p.push({event:T,listeners:A}),T.data=y)),JE(p,t,u,a,d)}AM(p,e)})}function Yl(t,e,a){return{instance:t,listener:e,currentTarget:a}}function yd(t,e){for(var a=e+"Capture",n=[];t!==null;){var i=t,s=i.stateNode;if(i=i.tag,i!==5&&i!==26&&i!==27||s===null||(i=Fl(t,a),i!=null&&n.unshift(Yl(t,i,s)),i=Fl(t,e),i!=null&&n.push(Yl(t,i,s))),t.tag===3)return n;t=t.return}return[]}function jE(t){if(t===null)return null;do t=t.return;while(t&&t.tag!==5&&t.tag!==27);return t||null}function Ny(t,e,a,n,i){for(var s=e._reactName,r=[];a!==null&&a!==n;){var o=a,l=o.alternate,u=o.stateNode;if(o=o.tag,l!==null&&l===n)break;o!==5&&o!==26&&o!==27||u===null||(l=u,i?(u=Fl(a,s),u!=null&&r.unshift(Yl(a,u,l))):i||(u=Fl(a,s),u!=null&&r.push(Yl(a,u,l)))),a=a.return}r.length!==0&&t.push({event:e,listeners:r})}var $E=/\r\n?/g,ew=/\u0000|\uFFFD/g;function Fy(t){return(typeof t=="string"?t:""+t).replace($E,`
`).replace(ew,"")}function IM(t,e){return e=Fy(e),Fy(t)===e}function ot(t,e,a,n,i,s){switch(a){case"children":typeof n=="string"?e==="body"||e==="textarea"&&n===""||oo(t,n):(typeof n=="number"||typeof n=="bigint")&&e!=="body"&&oo(t,""+n);break;case"className":Mf(t,"class",n);break;case"tabIndex":Mf(t,"tabindex",n);break;case"dir":case"role":case"viewBox":case"width":case"height":Mf(t,a,n);break;case"style":L_(t,n,s);break;case"data":if(e!=="object"){Mf(t,"data",n);break}case"src":case"href":if(n===""&&(e!=="a"||a!=="href")){t.removeAttribute(a);break}if(n==null||typeof n=="function"||typeof n=="symbol"||typeof n=="boolean"){t.removeAttribute(a);break}n=Nf(""+n),t.setAttribute(a,n);break;case"action":case"formAction":if(typeof n=="function"){t.setAttribute(a,"javascript:throw new Error('A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().')");break}else typeof s=="function"&&(a==="formAction"?(e!=="input"&&ot(t,e,"name",i.name,i,null),ot(t,e,"formEncType",i.formEncType,i,null),ot(t,e,"formMethod",i.formMethod,i,null),ot(t,e,"formTarget",i.formTarget,i,null)):(ot(t,e,"encType",i.encType,i,null),ot(t,e,"method",i.method,i,null),ot(t,e,"target",i.target,i,null)));if(n==null||typeof n=="symbol"||typeof n=="boolean"){t.removeAttribute(a);break}n=Nf(""+n),t.setAttribute(a,n);break;case"onClick":n!=null&&(t.onclick=pi);break;case"onScroll":n!=null&&ke("scroll",t);break;case"onScrollEnd":n!=null&&ke("scrollend",t);break;case"dangerouslySetInnerHTML":if(n!=null){if(typeof n!="object"||!("__html"in n))throw Error(Q(61));if(a=n.__html,a!=null){if(i.children!=null)throw Error(Q(60));t.innerHTML=a}}break;case"multiple":t.multiple=n&&typeof n!="function"&&typeof n!="symbol";break;case"muted":t.muted=n&&typeof n!="function"&&typeof n!="symbol";break;case"suppressContentEditableWarning":case"suppressHydrationWarning":case"defaultValue":case"defaultChecked":case"innerHTML":case"ref":break;case"autoFocus":break;case"xlinkHref":if(n==null||typeof n=="function"||typeof n=="boolean"||typeof n=="symbol"){t.removeAttribute("xlink:href");break}a=Nf(""+n),t.setAttributeNS("http://www.w3.org/1999/xlink","xlink:href",a);break;case"contentEditable":case"spellCheck":case"draggable":case"value":case"autoReverse":case"externalResourcesRequired":case"focusable":case"preserveAlpha":n!=null&&typeof n!="function"&&typeof n!="symbol"?t.setAttribute(a,""+n):t.removeAttribute(a);break;case"inert":case"allowFullScreen":case"async":case"autoPlay":case"controls":case"default":case"defer":case"disabled":case"disablePictureInPicture":case"disableRemotePlayback":case"formNoValidate":case"hidden":case"loop":case"noModule":case"noValidate":case"open":case"playsInline":case"readOnly":case"required":case"reversed":case"scoped":case"seamless":case"itemScope":n&&typeof n!="function"&&typeof n!="symbol"?t.setAttribute(a,""):t.removeAttribute(a);break;case"capture":case"download":n===!0?t.setAttribute(a,""):n!==!1&&n!=null&&typeof n!="function"&&typeof n!="symbol"?t.setAttribute(a,n):t.removeAttribute(a);break;case"cols":case"rows":case"size":case"span":n!=null&&typeof n!="function"&&typeof n!="symbol"&&!isNaN(n)&&1<=n?t.setAttribute(a,n):t.removeAttribute(a);break;case"rowSpan":case"start":n==null||typeof n=="function"||typeof n=="symbol"||isNaN(n)?t.removeAttribute(a):t.setAttribute(a,n);break;case"popover":ke("beforetoggle",t),ke("toggle",t),Of(t,"popover",n);break;case"xlinkActuate":ri(t,"http://www.w3.org/1999/xlink","xlink:actuate",n);break;case"xlinkArcrole":ri(t,"http://www.w3.org/1999/xlink","xlink:arcrole",n);break;case"xlinkRole":ri(t,"http://www.w3.org/1999/xlink","xlink:role",n);break;case"xlinkShow":ri(t,"http://www.w3.org/1999/xlink","xlink:show",n);break;case"xlinkTitle":ri(t,"http://www.w3.org/1999/xlink","xlink:title",n);break;case"xlinkType":ri(t,"http://www.w3.org/1999/xlink","xlink:type",n);break;case"xmlBase":ri(t,"http://www.w3.org/XML/1998/namespace","xml:base",n);break;case"xmlLang":ri(t,"http://www.w3.org/XML/1998/namespace","xml:lang",n);break;case"xmlSpace":ri(t,"http://www.w3.org/XML/1998/namespace","xml:space",n);break;case"is":Of(t,"is",n);break;case"innerText":case"textContent":break;default:(!(2<a.length)||a[0]!=="o"&&a[0]!=="O"||a[1]!=="n"&&a[1]!=="N")&&(a=wI.get(a)||a,Of(t,a,n))}}function Xm(t,e,a,n,i,s){switch(a){case"style":L_(t,n,s);break;case"dangerouslySetInnerHTML":if(n!=null){if(typeof n!="object"||!("__html"in n))throw Error(Q(61));if(a=n.__html,a!=null){if(i.children!=null)throw Error(Q(60));t.innerHTML=a}}break;case"children":typeof n=="string"?oo(t,n):(typeof n=="number"||typeof n=="bigint")&&oo(t,""+n);break;case"onScroll":n!=null&&ke("scroll",t);break;case"onScrollEnd":n!=null&&ke("scrollend",t);break;case"onClick":n!=null&&(t.onclick=pi);break;case"suppressContentEditableWarning":case"suppressHydrationWarning":case"innerHTML":case"ref":break;case"innerText":case"textContent":break;default:if(!y_.hasOwnProperty(a))e:{if(a[0]==="o"&&a[1]==="n"&&(i=a.endsWith("Capture"),e=a.slice(2,i?a.length-7:void 0),s=t[Ra]||null,s=s!=null?s[a]:null,typeof s=="function"&&t.removeEventListener(e,s,i),typeof n=="function")){typeof s!="function"&&s!==null&&(a in t?t[a]=null:t.hasAttribute(a)&&t.removeAttribute(a)),t.addEventListener(e,n,i);break e}a in t?t[a]=n:n===!0?t.setAttribute(a,""):Of(t,a,n)}}}function ua(t,e,a){switch(e){case"div":case"span":case"svg":case"path":case"a":case"g":case"p":case"li":break;case"img":ke("error",t),ke("load",t);var n=!1,i=!1,s;for(s in a)if(a.hasOwnProperty(s)){var r=a[s];if(r!=null)switch(s){case"src":n=!0;break;case"srcSet":i=!0;break;case"children":case"dangerouslySetInnerHTML":throw Error(Q(137,e));default:ot(t,e,s,r,a,null)}}i&&ot(t,e,"srcSet",a.srcSet,a,null),n&&ot(t,e,"src",a.src,a,null);return;case"input":ke("invalid",t);var o=s=r=i=null,l=null,u=null;for(n in a)if(a.hasOwnProperty(n)){var d=a[n];if(d!=null)switch(n){case"name":i=d;break;case"type":r=d;break;case"checked":l=d;break;case"defaultChecked":u=d;break;case"value":s=d;break;case"defaultValue":o=d;break;case"children":case"dangerouslySetInnerHTML":if(d!=null)throw Error(Q(137,e));break;default:ot(t,e,n,d,a,null)}}M_(t,s,o,l,u,r,i,!1);return;case"select":ke("invalid",t),n=r=s=null;for(i in a)if(a.hasOwnProperty(i)&&(o=a[i],o!=null))switch(i){case"value":s=o;break;case"defaultValue":r=o;break;case"multiple":n=o;default:ot(t,e,i,o,a,null)}e=s,a=r,t.multiple=!!n,e!=null?$r(t,!!n,e,!1):a!=null&&$r(t,!!n,a,!0);return;case"textarea":ke("invalid",t),s=i=n=null;for(r in a)if(a.hasOwnProperty(r)&&(o=a[r],o!=null))switch(r){case"value":n=o;break;case"defaultValue":i=o;break;case"children":s=o;break;case"dangerouslySetInnerHTML":if(o!=null)throw Error(Q(91));break;default:ot(t,e,r,o,a,null)}C_(t,n,i,s);return;case"option":for(l in a)a.hasOwnProperty(l)&&(n=a[l],n!=null)&&(l==="selected"?t.selected=n&&typeof n!="function"&&typeof n!="symbol":ot(t,e,l,n,a,null));return;case"dialog":ke("beforetoggle",t),ke("toggle",t),ke("cancel",t),ke("close",t);break;case"iframe":case"object":ke("load",t);break;case"video":case"audio":for(n=0;n<Xl.length;n++)ke(Xl[n],t);break;case"image":ke("error",t),ke("load",t);break;case"details":ke("toggle",t);break;case"embed":case"source":case"link":ke("error",t),ke("load",t);case"area":case"base":case"br":case"col":case"hr":case"keygen":case"meta":case"param":case"track":case"wbr":case"menuitem":for(u in a)if(a.hasOwnProperty(u)&&(n=a[u],n!=null))switch(u){case"children":case"dangerouslySetInnerHTML":throw Error(Q(137,e));default:ot(t,e,u,n,a,null)}return;default:if(lg(e)){for(d in a)a.hasOwnProperty(d)&&(n=a[d],n!==void 0&&Xm(t,e,d,n,a,void 0));return}}for(o in a)a.hasOwnProperty(o)&&(n=a[o],n!=null&&ot(t,e,o,n,a,null))}function tw(t,e,a,n){switch(e){case"div":case"span":case"svg":case"path":case"a":case"g":case"p":case"li":break;case"input":var i=null,s=null,r=null,o=null,l=null,u=null,d=null;for(h in a){var p=a[h];if(a.hasOwnProperty(h)&&p!=null)switch(h){case"checked":break;case"value":break;case"defaultValue":l=p;default:n.hasOwnProperty(h)||ot(t,e,h,null,n,p)}}for(var c in n){var h=n[c];if(p=a[c],n.hasOwnProperty(c)&&(h!=null||p!=null))switch(c){case"type":s=h;break;case"name":i=h;break;case"checked":u=h;break;case"defaultChecked":d=h;break;case"value":r=h;break;case"defaultValue":o=h;break;case"children":case"dangerouslySetInnerHTML":if(h!=null)throw Error(Q(137,e));break;default:h!==p&&ot(t,e,c,h,n,p)}}xm(t,r,o,l,u,d,s,i);return;case"select":h=r=o=c=null;for(s in a)if(l=a[s],a.hasOwnProperty(s)&&l!=null)switch(s){case"value":break;case"multiple":h=l;default:n.hasOwnProperty(s)||ot(t,e,s,null,n,l)}for(i in n)if(s=n[i],l=a[i],n.hasOwnProperty(i)&&(s!=null||l!=null))switch(i){case"value":c=s;break;case"defaultValue":o=s;break;case"multiple":r=s;default:s!==l&&ot(t,e,i,s,n,l)}e=o,a=r,n=h,c!=null?$r(t,!!a,c,!1):!!n!=!!a&&(e!=null?$r(t,!!a,e,!0):$r(t,!!a,a?[]:"",!1));return;case"textarea":h=c=null;for(o in a)if(i=a[o],a.hasOwnProperty(o)&&i!=null&&!n.hasOwnProperty(o))switch(o){case"value":break;case"children":break;default:ot(t,e,o,null,n,i)}for(r in n)if(i=n[r],s=a[r],n.hasOwnProperty(r)&&(i!=null||s!=null))switch(r){case"value":c=i;break;case"defaultValue":h=i;break;case"children":break;case"dangerouslySetInnerHTML":if(i!=null)throw Error(Q(91));break;default:i!==s&&ot(t,e,r,i,n,s)}b_(t,c,h);return;case"option":for(var v in a)c=a[v],a.hasOwnProperty(v)&&c!=null&&!n.hasOwnProperty(v)&&(v==="selected"?t.selected=!1:ot(t,e,v,null,n,c));for(l in n)c=n[l],h=a[l],n.hasOwnProperty(l)&&c!==h&&(c!=null||h!=null)&&(l==="selected"?t.selected=c&&typeof c!="function"&&typeof c!="symbol":ot(t,e,l,c,n,h));return;case"img":case"link":case"area":case"base":case"br":case"col":case"embed":case"hr":case"keygen":case"meta":case"param":case"source":case"track":case"wbr":case"menuitem":for(var b in a)c=a[b],a.hasOwnProperty(b)&&c!=null&&!n.hasOwnProperty(b)&&ot(t,e,b,null,n,c);for(u in n)if(c=n[u],h=a[u],n.hasOwnProperty(u)&&c!==h&&(c!=null||h!=null))switch(u){case"children":case"dangerouslySetInnerHTML":if(c!=null)throw Error(Q(137,e));break;default:ot(t,e,u,c,n,h)}return;default:if(lg(e)){for(var m in a)c=a[m],a.hasOwnProperty(m)&&c!==void 0&&!n.hasOwnProperty(m)&&Xm(t,e,m,void 0,n,c);for(d in n)c=n[d],h=a[d],!n.hasOwnProperty(d)||c===h||c===void 0&&h===void 0||Xm(t,e,d,c,n,h);return}}for(var f in a)c=a[f],a.hasOwnProperty(f)&&c!=null&&!n.hasOwnProperty(f)&&ot(t,e,f,null,n,c);for(p in n)c=n[p],h=a[p],!n.hasOwnProperty(p)||c===h||c==null&&h==null||ot(t,e,p,c,n,h)}function zy(t){switch(t){case"css":case"script":case"font":case"img":case"image":case"input":case"link":return!0;default:return!1}}function aw(){if(typeof performance.getEntriesByType=="function"){for(var t=0,e=0,a=performance.getEntriesByType("resource"),n=0;n<a.length;n++){var i=a[n],s=i.transferSize,r=i.initiatorType,o=i.duration;if(s&&o&&zy(r)){for(r=0,o=i.responseEnd,n+=1;n<a.length;n++){var l=a[n],u=l.startTime;if(u>o)break;var d=l.transferSize,p=l.initiatorType;d&&zy(p)&&(l=l.responseEnd,r+=d*(l<o?1:(o-u)/(l-u)))}if(--n,e+=8*(s+r)/(i.duration/1e3),t++,10<t)break}}if(0<t)return e/t/1e6}return navigator.connection&&(t=navigator.connection.downlink,typeof t=="number")?t:5}var Ym=null,Zm=null;function _d(t){return t.nodeType===9?t:t.ownerDocument}function ky(t){switch(t){case"http://www.w3.org/2000/svg":return 1;case"http://www.w3.org/1998/Math/MathML":return 2;default:return 0}}function EM(t,e){if(t===0)switch(e){case"svg":return 1;case"math":return 2;default:return 0}return t===1&&e==="foreignObject"?0:t}function Km(t,e){return t==="textarea"||t==="noscript"||typeof e.children=="string"||typeof e.children=="number"||typeof e.children=="bigint"||typeof e.dangerouslySetInnerHTML=="object"&&e.dangerouslySetInnerHTML!==null&&e.dangerouslySetInnerHTML.__html!=null}var sm=null;function nw(){var t=window.event;return t&&t.type==="popstate"?t===sm?!1:(sm=t,!0):(sm=null,!1)}var wM=typeof setTimeout=="function"?setTimeout:void 0,iw=typeof clearTimeout=="function"?clearTimeout:void 0,Hy=typeof Promise=="function"?Promise:void 0,sw=typeof queueMicrotask=="function"?queueMicrotask:typeof Hy<"u"?function(t){return Hy.resolve(null).then(t).catch(rw)}:wM;function rw(t){setTimeout(function(){throw t})}function Ss(t){return t==="head"}function Vy(t,e){var a=e,n=0;do{var i=a.nextSibling;if(t.removeChild(a),i&&i.nodeType===8)if(a=i.data,a==="/$"||a==="/&"){if(n===0){t.removeChild(i),go(e);return}n--}else if(a==="$"||a==="$?"||a==="$~"||a==="$!"||a==="&")n++;else if(a==="html")Ol(t.ownerDocument.documentElement);else if(a==="head"){a=t.ownerDocument.head,Ol(a);for(var s=a.firstChild;s;){var r=s.nextSibling,o=s.nodeName;s[tu]||o==="SCRIPT"||o==="STYLE"||o==="LINK"&&s.rel.toLowerCase()==="stylesheet"||a.removeChild(s),s=r}}else a==="body"&&Ol(t.ownerDocument.body);a=i}while(a);go(e)}function Gy(t,e){var a=t;t=0;do{var n=a.nextSibling;if(a.nodeType===1?e?(a._stashedDisplay=a.style.display,a.style.display="none"):(a.style.display=a._stashedDisplay||"",a.getAttribute("style")===""&&a.removeAttribute("style")):a.nodeType===3&&(e?(a._stashedText=a.nodeValue,a.nodeValue=""):a.nodeValue=a._stashedText||""),n&&n.nodeType===8)if(a=n.data,a==="/$"){if(t===0)break;t--}else a!=="$"&&a!=="$?"&&a!=="$~"&&a!=="$!"||t++;a=n}while(a)}function Jm(t){var e=t.firstChild;for(e&&e.nodeType===10&&(e=e.nextSibling);e;){var a=e;switch(e=e.nextSibling,a.nodeName){case"HTML":case"HEAD":case"BODY":Jm(a),og(a);continue;case"SCRIPT":case"STYLE":continue;case"LINK":if(a.rel.toLowerCase()==="stylesheet")continue}t.removeChild(a)}}function ow(t,e,a,n){for(;t.nodeType===1;){var i=a;if(t.nodeName.toLowerCase()!==e.toLowerCase()){if(!n&&(t.nodeName!=="INPUT"||t.type!=="hidden"))break}else if(n){if(!t[tu])switch(e){case"meta":if(!t.hasAttribute("itemprop"))break;return t;case"link":if(s=t.getAttribute("rel"),s==="stylesheet"&&t.hasAttribute("data-precedence"))break;if(s!==i.rel||t.getAttribute("href")!==(i.href==null||i.href===""?null:i.href)||t.getAttribute("crossorigin")!==(i.crossOrigin==null?null:i.crossOrigin)||t.getAttribute("title")!==(i.title==null?null:i.title))break;return t;case"style":if(t.hasAttribute("data-precedence"))break;return t;case"script":if(s=t.getAttribute("src"),(s!==(i.src==null?null:i.src)||t.getAttribute("type")!==(i.type==null?null:i.type)||t.getAttribute("crossorigin")!==(i.crossOrigin==null?null:i.crossOrigin))&&s&&t.hasAttribute("async")&&!t.hasAttribute("itemprop"))break;return t;default:return t}}else if(e==="input"&&t.type==="hidden"){var s=i.name==null?null:""+i.name;if(i.type==="hidden"&&t.getAttribute("name")===s)return t}else return t;if(t=dn(t.nextSibling),t===null)break}return null}function lw(t,e,a){if(e==="")return null;for(;t.nodeType!==3;)if((t.nodeType!==1||t.nodeName!=="INPUT"||t.type!=="hidden")&&!a||(t=dn(t.nextSibling),t===null))return null;return t}function RM(t,e){for(;t.nodeType!==8;)if((t.nodeType!==1||t.nodeName!=="INPUT"||t.type!=="hidden")&&!e||(t=dn(t.nextSibling),t===null))return null;return t}function Qm(t){return t.data==="$?"||t.data==="$~"}function jm(t){return t.data==="$!"||t.data==="$?"&&t.ownerDocument.readyState!=="loading"}function uw(t,e){var a=t.ownerDocument;if(t.data==="$~")t._reactRetry=e;else if(t.data!=="$?"||a.readyState!=="loading")e();else{var n=function(){e(),a.removeEventListener("DOMContentLoaded",n)};a.addEventListener("DOMContentLoaded",n),t._reactRetry=n}}function dn(t){for(;t!=null;t=t.nextSibling){var e=t.nodeType;if(e===1||e===3)break;if(e===8){if(e=t.data,e==="$"||e==="$!"||e==="$?"||e==="$~"||e==="&"||e==="F!"||e==="F")break;if(e==="/$"||e==="/&")return null}}return t}var $m=null;function qy(t){t=t.nextSibling;for(var e=0;t;){if(t.nodeType===8){var a=t.data;if(a==="/$"||a==="/&"){if(e===0)return dn(t.nextSibling);e--}else a!=="$"&&a!=="$!"&&a!=="$?"&&a!=="$~"&&a!=="&"||e++}t=t.nextSibling}return null}function Wy(t){t=t.previousSibling;for(var e=0;t;){if(t.nodeType===8){var a=t.data;if(a==="$"||a==="$!"||a==="$?"||a==="$~"||a==="&"){if(e===0)return t;e--}else a!=="/$"&&a!=="/&"||e++}t=t.previousSibling}return null}function DM(t,e,a){switch(e=_d(a),t){case"html":if(t=e.documentElement,!t)throw Error(Q(452));return t;case"head":if(t=e.head,!t)throw Error(Q(453));return t;case"body":if(t=e.body,!t)throw Error(Q(454));return t;default:throw Error(Q(451))}}function Ol(t){for(var e=t.attributes;e.length;)t.removeAttributeNode(e[0]);og(t)}var hn=new Map,Xy=new Set;function Sd(t){return typeof t.getRootNode=="function"?t.getRootNode():t.nodeType===9?t:t.ownerDocument}var Ci=tt.d;tt.d={f:cw,r:fw,D:dw,C:hw,L:pw,m:mw,X:xw,S:gw,M:vw};function cw(){var t=Ci.f(),e=Fd();return t||e}function fw(t){var e=vo(t);e!==null&&e.tag===5&&e.type==="form"?LS(e):Ci.r(t)}var Mo=typeof document>"u"?null:document;function PM(t,e,a){var n=Mo;if(n&&typeof e=="string"&&e){var i=ln(e);i='link[rel="'+t+'"][href="'+i+'"]',typeof a=="string"&&(i+='[crossorigin="'+a+'"]'),Xy.has(i)||(Xy.add(i),t={rel:t,crossOrigin:a,href:e},n.querySelector(i)===null&&(e=n.createElement("link"),ua(e,"link",t),ta(e),n.head.appendChild(e)))}}function dw(t){Ci.D(t),PM("dns-prefetch",t,null)}function hw(t,e){Ci.C(t,e),PM("preconnect",t,e)}function pw(t,e,a){Ci.L(t,e,a);var n=Mo;if(n&&t&&e){var i='link[rel="preload"][as="'+ln(e)+'"]';e==="image"&&a&&a.imageSrcSet?(i+='[imagesrcset="'+ln(a.imageSrcSet)+'"]',typeof a.imageSizes=="string"&&(i+='[imagesizes="'+ln(a.imageSizes)+'"]')):i+='[href="'+ln(t)+'"]';var s=i;switch(e){case"style":s=mo(t);break;case"script":s=bo(t)}hn.has(s)||(t=Mt({rel:"preload",href:e==="image"&&a&&a.imageSrcSet?void 0:t,as:e},a),hn.set(s,t),n.querySelector(i)!==null||e==="style"&&n.querySelector(ou(s))||e==="script"&&n.querySelector(lu(s))||(e=n.createElement("link"),ua(e,"link",t),ta(e),n.head.appendChild(e)))}}function mw(t,e){Ci.m(t,e);var a=Mo;if(a&&t){var n=e&&typeof e.as=="string"?e.as:"script",i='link[rel="modulepreload"][as="'+ln(n)+'"][href="'+ln(t)+'"]',s=i;switch(n){case"audioworklet":case"paintworklet":case"serviceworker":case"sharedworker":case"worker":case"script":s=bo(t)}if(!hn.has(s)&&(t=Mt({rel:"modulepreload",href:t},e),hn.set(s,t),a.querySelector(i)===null)){switch(n){case"audioworklet":case"paintworklet":case"serviceworker":case"sharedworker":case"worker":case"script":if(a.querySelector(lu(s)))return}n=a.createElement("link"),ua(n,"link",t),ta(n),a.head.appendChild(n)}}}function gw(t,e,a){Ci.S(t,e,a);var n=Mo;if(n&&t){var i=jr(n).hoistableStyles,s=mo(t);e=e||"default";var r=i.get(s);if(!r){var o={loading:0,preload:null};if(r=n.querySelector(ou(s)))o.loading=5;else{t=Mt({rel:"stylesheet",href:t,"data-precedence":e},a),(a=hn.get(s))&&Xg(t,a);var l=r=n.createElement("link");ta(l),ua(l,"link",t),l._p=new Promise(function(u,d){l.onload=u,l.onerror=d}),l.addEventListener("load",function(){o.loading|=1}),l.addEventListener("error",function(){o.loading|=2}),o.loading|=4,Yf(r,e,n)}r={type:"stylesheet",instance:r,count:1,state:o},i.set(s,r)}}}function xw(t,e){Ci.X(t,e);var a=Mo;if(a&&t){var n=jr(a).hoistableScripts,i=bo(t),s=n.get(i);s||(s=a.querySelector(lu(i)),s||(t=Mt({src:t,async:!0},e),(e=hn.get(i))&&Yg(t,e),s=a.createElement("script"),ta(s),ua(s,"link",t),a.head.appendChild(s)),s={type:"script",instance:s,count:1,state:null},n.set(i,s))}}function vw(t,e){Ci.M(t,e);var a=Mo;if(a&&t){var n=jr(a).hoistableScripts,i=bo(t),s=n.get(i);s||(s=a.querySelector(lu(i)),s||(t=Mt({src:t,async:!0,type:"module"},e),(e=hn.get(i))&&Yg(t,e),s=a.createElement("script"),ta(s),ua(s,"link",t),a.head.appendChild(s)),s={type:"script",instance:s,count:1,state:null},n.set(i,s))}}function Yy(t,e,a,n){var i=(i=os.current)?Sd(i):null;if(!i)throw Error(Q(446));switch(t){case"meta":case"title":return null;case"style":return typeof a.precedence=="string"&&typeof a.href=="string"?(e=mo(a.href),a=jr(i).hoistableStyles,n=a.get(e),n||(n={type:"style",instance:null,count:0,state:null},a.set(e,n)),n):{type:"void",instance:null,count:0,state:null};case"link":if(a.rel==="stylesheet"&&typeof a.href=="string"&&typeof a.precedence=="string"){t=mo(a.href);var s=jr(i).hoistableStyles,r=s.get(t);if(r||(i=i.ownerDocument||i,r={type:"stylesheet",instance:null,count:0,state:{loading:0,preload:null}},s.set(t,r),(s=i.querySelector(ou(t)))&&!s._p&&(r.instance=s,r.state.loading=5),hn.has(t)||(a={rel:"preload",as:"style",href:a.href,crossOrigin:a.crossOrigin,integrity:a.integrity,media:a.media,hrefLang:a.hrefLang,referrerPolicy:a.referrerPolicy},hn.set(t,a),s||yw(i,t,a,r.state))),e&&n===null)throw Error(Q(528,""));return r}if(e&&n!==null)throw Error(Q(529,""));return null;case"script":return e=a.async,a=a.src,typeof a=="string"&&e&&typeof e!="function"&&typeof e!="symbol"?(e=bo(a),a=jr(i).hoistableScripts,n=a.get(e),n||(n={type:"script",instance:null,count:0,state:null},a.set(e,n)),n):{type:"void",instance:null,count:0,state:null};default:throw Error(Q(444,t))}}function mo(t){return'href="'+ln(t)+'"'}function ou(t){return'link[rel="stylesheet"]['+t+"]"}function UM(t){return Mt({},t,{"data-precedence":t.precedence,precedence:null})}function yw(t,e,a,n){t.querySelector('link[rel="preload"][as="style"]['+e+"]")?n.loading=1:(e=t.createElement("link"),n.preload=e,e.addEventListener("load",function(){return n.loading|=1}),e.addEventListener("error",function(){return n.loading|=2}),ua(e,"link",a),ta(e),t.head.appendChild(e))}function bo(t){return'[src="'+ln(t)+'"]'}function lu(t){return"script[async]"+t}function Zy(t,e,a){if(e.count++,e.instance===null)switch(e.type){case"style":var n=t.querySelector('style[data-href~="'+ln(a.href)+'"]');if(n)return e.instance=n,ta(n),n;var i=Mt({},a,{"data-href":a.href,"data-precedence":a.precedence,href:null,precedence:null});return n=(t.ownerDocument||t).createElement("style"),ta(n),ua(n,"style",i),Yf(n,a.precedence,t),e.instance=n;case"stylesheet":i=mo(a.href);var s=t.querySelector(ou(i));if(s)return e.state.loading|=4,e.instance=s,ta(s),s;n=UM(a),(i=hn.get(i))&&Xg(n,i),s=(t.ownerDocument||t).createElement("link"),ta(s);var r=s;return r._p=new Promise(function(o,l){r.onload=o,r.onerror=l}),ua(s,"link",n),e.state.loading|=4,Yf(s,a.precedence,t),e.instance=s;case"script":return s=bo(a.src),(i=t.querySelector(lu(s)))?(e.instance=i,ta(i),i):(n=a,(i=hn.get(s))&&(n=Mt({},a),Yg(n,i)),t=t.ownerDocument||t,i=t.createElement("script"),ta(i),ua(i,"link",n),t.head.appendChild(i),e.instance=i);case"void":return null;default:throw Error(Q(443,e.type))}else e.type==="stylesheet"&&(e.state.loading&4)===0&&(n=e.instance,e.state.loading|=4,Yf(n,a.precedence,t));return e.instance}function Yf(t,e,a){for(var n=a.querySelectorAll('link[rel="stylesheet"][data-precedence],style[data-precedence]'),i=n.length?n[n.length-1]:null,s=i,r=0;r<n.length;r++){var o=n[r];if(o.dataset.precedence===e)s=o;else if(s!==i)break}s?s.parentNode.insertBefore(t,s.nextSibling):(e=a.nodeType===9?a.head:a,e.insertBefore(t,e.firstChild))}function Xg(t,e){t.crossOrigin==null&&(t.crossOrigin=e.crossOrigin),t.referrerPolicy==null&&(t.referrerPolicy=e.referrerPolicy),t.title==null&&(t.title=e.title)}function Yg(t,e){t.crossOrigin==null&&(t.crossOrigin=e.crossOrigin),t.referrerPolicy==null&&(t.referrerPolicy=e.referrerPolicy),t.integrity==null&&(t.integrity=e.integrity)}var Zf=null;function Ky(t,e,a){if(Zf===null){var n=new Map,i=Zf=new Map;i.set(a,n)}else i=Zf,n=i.get(a),n||(n=new Map,i.set(a,n));if(n.has(t))return n;for(n.set(t,null),a=a.getElementsByTagName(t),i=0;i<a.length;i++){var s=a[i];if(!(s[tu]||s[ra]||t==="link"&&s.getAttribute("rel")==="stylesheet")&&s.namespaceURI!=="http://www.w3.org/2000/svg"){var r=s.getAttribute(e)||"";r=t+r;var o=n.get(r);o?o.push(s):n.set(r,[s])}}return n}function Jy(t,e,a){t=t.ownerDocument||t,t.head.insertBefore(a,e==="title"?t.querySelector("head > title"):null)}function _w(t,e,a){if(a===1||e.itemProp!=null)return!1;switch(t){case"meta":case"title":return!0;case"style":if(typeof e.precedence!="string"||typeof e.href!="string"||e.href==="")break;return!0;case"link":if(typeof e.rel!="string"||typeof e.href!="string"||e.href===""||e.onLoad||e.onError)break;return e.rel==="stylesheet"?(t=e.disabled,typeof e.precedence=="string"&&t==null):!0;case"script":if(e.async&&typeof e.async!="function"&&typeof e.async!="symbol"&&!e.onLoad&&!e.onError&&e.src&&typeof e.src=="string")return!0}return!1}function BM(t){return!(t.type==="stylesheet"&&(t.state.loading&3)===0)}function Sw(t,e,a,n){if(a.type==="stylesheet"&&(typeof n.media!="string"||matchMedia(n.media).matches!==!1)&&(a.state.loading&4)===0){if(a.instance===null){var i=mo(n.href),s=e.querySelector(ou(i));if(s){e=s._p,e!==null&&typeof e=="object"&&typeof e.then=="function"&&(t.count++,t=Md.bind(t),e.then(t,t)),a.state.loading|=4,a.instance=s,ta(s);return}s=e.ownerDocument||e,n=UM(n),(i=hn.get(i))&&Xg(n,i),s=s.createElement("link"),ta(s);var r=s;r._p=new Promise(function(o,l){r.onload=o,r.onerror=l}),ua(s,"link",n),a.instance=s}t.stylesheets===null&&(t.stylesheets=new Map),t.stylesheets.set(a,e),(e=a.state.preload)&&(a.state.loading&3)===0&&(t.count++,a=Md.bind(t),e.addEventListener("load",a),e.addEventListener("error",a))}}var rm=0;function Mw(t,e){return t.stylesheets&&t.count===0&&Kf(t,t.stylesheets),0<t.count||0<t.imgCount?function(a){var n=setTimeout(function(){if(t.stylesheets&&Kf(t,t.stylesheets),t.unsuspend){var s=t.unsuspend;t.unsuspend=null,s()}},6e4+e);0<t.imgBytes&&rm===0&&(rm=62500*aw());var i=setTimeout(function(){if(t.waitingForImages=!1,t.count===0&&(t.stylesheets&&Kf(t,t.stylesheets),t.unsuspend)){var s=t.unsuspend;t.unsuspend=null,s()}},(t.imgBytes>rm?50:800)+e);return t.unsuspend=a,function(){t.unsuspend=null,clearTimeout(n),clearTimeout(i)}}:null}function Md(){if(this.count--,this.count===0&&(this.imgCount===0||!this.waitingForImages)){if(this.stylesheets)Kf(this,this.stylesheets);else if(this.unsuspend){var t=this.unsuspend;this.unsuspend=null,t()}}}var bd=null;function Kf(t,e){t.stylesheets=null,t.unsuspend!==null&&(t.count++,bd=new Map,e.forEach(bw,t),bd=null,Md.call(t))}function bw(t,e){if(!(e.state.loading&4)){var a=bd.get(t);if(a)var n=a.get(null);else{a=new Map,bd.set(t,a);for(var i=t.querySelectorAll("link[data-precedence],style[data-precedence]"),s=0;s<i.length;s++){var r=i[s];(r.nodeName==="LINK"||r.getAttribute("media")!=="not all")&&(a.set(r.dataset.precedence,r),n=r)}n&&a.set(null,n)}i=e.instance,r=i.getAttribute("data-precedence"),s=a.get(r)||n,s===n&&a.set(null,i),a.set(r,i),this.count++,n=Md.bind(this),i.addEventListener("load",n),i.addEventListener("error",n),s?s.parentNode.insertBefore(i,s.nextSibling):(t=t.nodeType===9?t.head:t,t.insertBefore(i,t.firstChild)),e.state.loading|=4}}var Zl={$$typeof:hi,Provider:null,Consumer:null,_currentValue:Gs,_currentValue2:Gs,_threadCount:0};function Cw(t,e,a,n,i,s,r,o,l){this.tag=1,this.containerInfo=t,this.pingCache=this.current=this.pendingChildren=null,this.timeoutHandle=-1,this.callbackNode=this.next=this.pendingContext=this.context=this.cancelPendingCommit=null,this.callbackPriority=0,this.expirationTimes=Dp(-1),this.entangledLanes=this.shellSuspendCounter=this.errorRecoveryDisabledLanes=this.expiredLanes=this.warmLanes=this.pingedLanes=this.suspendedLanes=this.pendingLanes=0,this.entanglements=Dp(0),this.hiddenUpdates=Dp(null),this.identifierPrefix=n,this.onUncaughtError=i,this.onCaughtError=s,this.onRecoverableError=r,this.pooledCache=null,this.pooledCacheLanes=0,this.formState=l,this.incompleteTransitions=new Map}function OM(t,e,a,n,i,s,r,o,l,u,d,p){return t=new Cw(t,e,a,r,l,u,d,p,o),e=1,s===!0&&(e|=24),s=Ga(3,null,null,e),t.current=s,s.stateNode=t,e=yg(),e.refCount++,t.pooledCache=e,e.refCount++,s.memoizedState={element:n,isDehydrated:a,cache:e},Mg(s),t}function NM(t){return t?(t=Zr,t):Zr}function FM(t,e,a,n,i,s){i=NM(i),n.context===null?n.context=i:n.pendingContext=i,n=us(e),n.payload={element:a},s=s===void 0?null:s,s!==null&&(n.callback=s),a=cs(t,n,e),a!==null&&(wa(a,t,e),Il(a,t,e))}function Qy(t,e){if(t=t.memoizedState,t!==null&&t.dehydrated!==null){var a=t.retryLane;t.retryLane=a!==0&&a<e?a:e}}function Zg(t,e){Qy(t,e),(t=t.alternate)&&Qy(t,e)}function zM(t){if(t.tag===13||t.tag===31){var e=ar(t,67108864);e!==null&&wa(e,t,67108864),Zg(t,67108864)}}function jy(t){if(t.tag===13||t.tag===31){var e=Za();e=sg(e);var a=ar(t,e);a!==null&&wa(a,t,e),Zg(t,e)}}var Cd=!0;function Lw(t,e,a,n){var i=we.T;we.T=null;var s=tt.p;try{tt.p=2,Kg(t,e,a,n)}finally{tt.p=s,we.T=i}}function Aw(t,e,a,n){var i=we.T;we.T=null;var s=tt.p;try{tt.p=8,Kg(t,e,a,n)}finally{tt.p=s,we.T=i}}function Kg(t,e,a,n){if(Cd){var i=eg(n);if(i===null)im(t,e,n,Ld,a),$y(t,n);else if(Iw(i,t,e,a,n))n.stopPropagation();else if($y(t,n),e&4&&-1<Tw.indexOf(t)){for(;i!==null;){var s=vo(i);if(s!==null)switch(s.tag){case 3:if(s=s.stateNode,s.current.memoizedState.isDehydrated){var r=ks(s.pendingLanes);if(r!==0){var o=s;for(o.pendingLanes|=2,o.entangledLanes|=2;r;){var l=1<<31-Ya(r);o.entanglements[1]|=l,r&=~l}Yn(s),(et&6)===0&&(pd=Wa()+500,ru(0,!1))}}break;case 31:case 13:o=ar(s,2),o!==null&&wa(o,s,2),Fd(),Zg(s,2)}if(s=eg(n),s===null&&im(t,e,n,Ld,a),s===i)break;i=s}i!==null&&n.stopPropagation()}else im(t,e,n,null,a)}}function eg(t){return t=ug(t),Jg(t)}var Ld=null;function Jg(t){if(Ld=null,t=Vr(t),t!==null){var e=Ql(t);if(e===null)t=null;else{var a=e.tag;if(a===13){if(t=s_(e),t!==null)return t;t=null}else if(a===31){if(t=r_(e),t!==null)return t;t=null}else if(a===3){if(e.stateNode.current.memoizedState.isDehydrated)return e.tag===3?e.stateNode.containerInfo:null;t=null}else e!==t&&(t=null)}}return Ld=t,null}function kM(t){switch(t){case"beforetoggle":case"cancel":case"click":case"close":case"contextmenu":case"copy":case"cut":case"auxclick":case"dblclick":case"dragend":case"dragstart":case"drop":case"focusin":case"focusout":case"input":case"invalid":case"keydown":case"keypress":case"keyup":case"mousedown":case"mouseup":case"paste":case"pause":case"play":case"pointercancel":case"pointerdown":case"pointerup":case"ratechange":case"reset":case"resize":case"seeked":case"submit":case"toggle":case"touchcancel":case"touchend":case"touchstart":case"volumechange":case"change":case"selectionchange":case"textInput":case"compositionstart":case"compositionend":case"compositionupdate":case"beforeblur":case"afterblur":case"beforeinput":case"blur":case"fullscreenchange":case"focus":case"hashchange":case"popstate":case"select":case"selectstart":return 2;case"drag":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"mousemove":case"mouseout":case"mouseover":case"pointermove":case"pointerout":case"pointerover":case"scroll":case"touchmove":case"wheel":case"mouseenter":case"mouseleave":case"pointerenter":case"pointerleave":return 8;case"message":switch(pI()){case c_:return 2;case f_:return 8;case ed:case mI:return 32;case d_:return 268435456;default:return 32}default:return 32}}var tg=!1,hs=null,ps=null,ms=null,Kl=new Map,Jl=new Map,ts=[],Tw="mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset".split(" ");function $y(t,e){switch(t){case"focusin":case"focusout":hs=null;break;case"dragenter":case"dragleave":ps=null;break;case"mouseover":case"mouseout":ms=null;break;case"pointerover":case"pointerout":Kl.delete(e.pointerId);break;case"gotpointercapture":case"lostpointercapture":Jl.delete(e.pointerId)}}function xl(t,e,a,n,i,s){return t===null||t.nativeEvent!==s?(t={blockedOn:e,domEventName:a,eventSystemFlags:n,nativeEvent:s,targetContainers:[i]},e!==null&&(e=vo(e),e!==null&&zM(e)),t):(t.eventSystemFlags|=n,e=t.targetContainers,i!==null&&e.indexOf(i)===-1&&e.push(i),t)}function Iw(t,e,a,n,i){switch(e){case"focusin":return hs=xl(hs,t,e,a,n,i),!0;case"dragenter":return ps=xl(ps,t,e,a,n,i),!0;case"mouseover":return ms=xl(ms,t,e,a,n,i),!0;case"pointerover":var s=i.pointerId;return Kl.set(s,xl(Kl.get(s)||null,t,e,a,n,i)),!0;case"gotpointercapture":return s=i.pointerId,Jl.set(s,xl(Jl.get(s)||null,t,e,a,n,i)),!0}return!1}function HM(t){var e=Vr(t.target);if(e!==null){var a=Ql(e);if(a!==null){if(e=a.tag,e===13){if(e=s_(a),e!==null){t.blockedOn=e,Ov(t.priority,function(){jy(a)});return}}else if(e===31){if(e=r_(a),e!==null){t.blockedOn=e,Ov(t.priority,function(){jy(a)});return}}else if(e===3&&a.stateNode.current.memoizedState.isDehydrated){t.blockedOn=a.tag===3?a.stateNode.containerInfo:null;return}}}t.blockedOn=null}function Jf(t){if(t.blockedOn!==null)return!1;for(var e=t.targetContainers;0<e.length;){var a=eg(t.nativeEvent);if(a===null){a=t.nativeEvent;var n=new a.constructor(a.type,a);ym=n,a.target.dispatchEvent(n),ym=null}else return e=vo(a),e!==null&&zM(e),t.blockedOn=a,!1;e.shift()}return!0}function e_(t,e,a){Jf(t)&&a.delete(e)}function Ew(){tg=!1,hs!==null&&Jf(hs)&&(hs=null),ps!==null&&Jf(ps)&&(ps=null),ms!==null&&Jf(ms)&&(ms=null),Kl.forEach(e_),Jl.forEach(e_)}function Uf(t,e){t.blockedOn===e&&(t.blockedOn=null,tg||(tg=!0,Jt.unstable_scheduleCallback(Jt.unstable_NormalPriority,Ew)))}var Bf=null;function t_(t){Bf!==t&&(Bf=t,Jt.unstable_scheduleCallback(Jt.unstable_NormalPriority,function(){Bf===t&&(Bf=null);for(var e=0;e<t.length;e+=3){var a=t[e],n=t[e+1],i=t[e+2];if(typeof n!="function"){if(Jg(n||a)===null)continue;break}var s=vo(a);s!==null&&(t.splice(e,3),e-=3,Bm(s,{pending:!0,data:i,method:a.method,action:n},n,i))}}))}function go(t){function e(l){return Uf(l,t)}hs!==null&&Uf(hs,t),ps!==null&&Uf(ps,t),ms!==null&&Uf(ms,t),Kl.forEach(e),Jl.forEach(e);for(var a=0;a<ts.length;a++){var n=ts[a];n.blockedOn===t&&(n.blockedOn=null)}for(;0<ts.length&&(a=ts[0],a.blockedOn===null);)HM(a),a.blockedOn===null&&ts.shift();if(a=(t.ownerDocument||t).$$reactFormReplay,a!=null)for(n=0;n<a.length;n+=3){var i=a[n],s=a[n+1],r=i[Ra]||null;if(typeof s=="function")r||t_(a);else if(r){var o=null;if(s&&s.hasAttribute("formAction")){if(i=s,r=s[Ra]||null)o=r.formAction;else if(Jg(i)!==null)continue}else o=r.action;typeof o=="function"?a[n+1]=o:(a.splice(n,3),n-=3),t_(a)}}}function VM(){function t(s){s.canIntercept&&s.info==="react-transition"&&s.intercept({handler:function(){return new Promise(function(r){return i=r})},focusReset:"manual",scroll:"manual"})}function e(){i!==null&&(i(),i=null),n||setTimeout(a,20)}function a(){if(!n&&!navigation.transition){var s=navigation.currentEntry;s&&s.url!=null&&navigation.navigate(s.url,{state:s.getState(),info:"react-transition",history:"replace"})}}if(typeof navigation=="object"){var n=!1,i=null;return navigation.addEventListener("navigate",t),navigation.addEventListener("navigatesuccess",e),navigation.addEventListener("navigateerror",e),setTimeout(a,100),function(){n=!0,navigation.removeEventListener("navigate",t),navigation.removeEventListener("navigatesuccess",e),navigation.removeEventListener("navigateerror",e),i!==null&&(i(),i=null)}}}function Qg(t){this._internalRoot=t}Hd.prototype.render=Qg.prototype.render=function(t){var e=this._internalRoot;if(e===null)throw Error(Q(409));var a=e.current,n=Za();FM(a,n,t,e,null,null)};Hd.prototype.unmount=Qg.prototype.unmount=function(){var t=this._internalRoot;if(t!==null){this._internalRoot=null;var e=t.containerInfo;FM(t.current,2,null,t,null,null),Fd(),e[xo]=null}};function Hd(t){this._internalRoot=t}Hd.prototype.unstable_scheduleHydration=function(t){if(t){var e=x_();t={blockedOn:null,target:t,priority:e};for(var a=0;a<ts.length&&e!==0&&e<ts[a].priority;a++);ts.splice(a,0,t),a===0&&HM(t)}};var a_=n_.version;if(a_!=="19.2.8")throw Error(Q(527,a_,"19.2.8"));tt.findDOMNode=function(t){var e=t._reactInternals;if(e===void 0)throw typeof t.render=="function"?Error(Q(188)):(t=Object.keys(t).join(","),Error(Q(268,t)));return t=oI(e),t=t!==null?o_(t):null,t=t===null?null:t.stateNode,t};var ww={bundleType:0,version:"19.2.8",rendererPackageName:"react-dom",currentDispatcherRef:we,reconcilerVersion:"19.2.8"};if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__<"u"&&(vl=__REACT_DEVTOOLS_GLOBAL_HOOK__,!vl.isDisabled&&vl.supportsFiber))try{jl=vl.inject(ww),Xa=vl}catch{}var vl;Vd.createRoot=function(t,e){if(!i_(t))throw Error(Q(299));var a=!1,n="",i=PS,s=US,r=BS;return e!=null&&(e.unstable_strictMode===!0&&(a=!0),e.identifierPrefix!==void 0&&(n=e.identifierPrefix),e.onUncaughtError!==void 0&&(i=e.onUncaughtError),e.onCaughtError!==void 0&&(s=e.onCaughtError),e.onRecoverableError!==void 0&&(r=e.onRecoverableError)),e=OM(t,1,!1,null,null,a,n,null,i,s,r,VM),t[xo]=e.current,Wg(t),new Qg(e)};Vd.hydrateRoot=function(t,e,a){if(!i_(t))throw Error(Q(299));var n=!1,i="",s=PS,r=US,o=BS,l=null;return a!=null&&(a.unstable_strictMode===!0&&(n=!0),a.identifierPrefix!==void 0&&(i=a.identifierPrefix),a.onUncaughtError!==void 0&&(s=a.onUncaughtError),a.onCaughtError!==void 0&&(r=a.onCaughtError),a.onRecoverableError!==void 0&&(o=a.onRecoverableError),a.formState!==void 0&&(l=a.formState)),e=OM(t,1,!0,e,a??null,n,i,l,s,r,o,VM),e.context=NM(null),a=e.current,n=Za(),n=sg(n),i=us(n),i.callback=null,cs(a,i,n),a=n,e.current.lanes=a,eu(e,a),Yn(e),t[xo]=e.current,Wg(t),new Hd(e)};Vd.version="19.2.8"});var XM=In((vP,WM)=>{"use strict";function qM(){if(!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__>"u"||typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE!="function"))try{__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(qM)}catch(t){console.error(t)}}qM(),WM.exports=GM()});var Zn=Ua(Kn());var hu=Ua(Kn());var du=(...t)=>t.filter((e,a,n)=>!!e&&e.trim()!==""&&n.indexOf(e)===a).join(" ").trim();var _x=t=>t.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase();var Sx=t=>t.replace(/^([A-Z])|[\s-_]+(\w)/g,(e,a,n)=>n?n.toUpperCase():a.toLowerCase());var jd=t=>{let e=Sx(t);return e.charAt(0).toUpperCase()+e.slice(1)};var Co=Ua(Kn());var Mx={xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"};var bx=t=>{for(let e in t)if(e.startsWith("aria-")||e==="role"||e==="title")return!0;return!1};var Cx=(0,Co.forwardRef)(({color:t="currentColor",size:e=24,strokeWidth:a=2,absoluteStrokeWidth:n,className:i="",children:s,iconNode:r,...o},l)=>(0,Co.createElement)("svg",{ref:l,...Mx,width:e,height:e,stroke:t,strokeWidth:n?Number(a)*24/Number(e):a,className:du("lucide",i),...!s&&!bx(o)&&{"aria-hidden":"true"},...o},[...r.map(([u,d])=>(0,Co.createElement)(u,d)),...Array.isArray(s)?s:[s]]));var pu=(t,e)=>{let a=(0,hu.forwardRef)(({className:n,...i},s)=>(0,hu.createElement)(Cx,{ref:s,iconNode:e,className:du(`lucide-${_x(jd(t))}`,`lucide-${t}`,n),...i}));return a.displayName=jd(t),a};var bb=[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["line",{x1:"12",x2:"12",y1:"8",y2:"12",key:"1pkeuh"}],["line",{x1:"12",x2:"12.01",y1:"16",y2:"16",key:"4dfq90"}]],Ii=pu("circle-alert",bb);var Cb=[["path",{d:"M21 12a9 9 0 1 1-6.219-8.56",key:"13zald"}]],Ei=pu("loader-circle",Cb);var hv=Ua(Kn(),1);var Lo={},Lx;function Lb(){if(Lx)return Lo;Lx=1,Object.defineProperty(Lo,"__esModule",{value:!0}),Lo.styleq=void 0;var t=new WeakMap,e="$$css";function a(i){var s,r,o;return i!=null&&(s=i.disableCache===!0,r=i.disableMix===!0,o=i.transform),function(){for(var u=[],d="",p=null,c="",h=s?null:t,v=new Array(arguments.length),b=0;b<arguments.length;b++)v[b]=arguments[b];for(;v.length>0;){var m=v.pop();if(!(m==null||m===!1)){if(Array.isArray(m)){for(var f=0;f<m.length;f++)v.push(m[f]);continue}var x=o!=null?o(m):m;if(x.$$css!=null){var S="";if(h!=null&&h.has(x)){var _=h.get(x);_!=null&&(S=_[0],c=_[2],u.push.apply(u,_[1]),h=_[3])}else{var L=[];for(var C in x){var T=x[C];if(C===e){var y=x[C];y!==!0&&(c=c?y+"; "+c:y);continue}typeof T=="string"||T===null?u.includes(C)||(u.push(C),h!=null&&L.push(C),typeof T=="string"&&(S+=S?" "+T:T)):console.error("styleq: ".concat(C," typeof ").concat(String(T),' is not "string" or "null".'))}if(h!=null){var A=new WeakMap;h.set(x,[S,L,c,A]),h=A}}S&&(d=d?S+" "+d:S)}else if(r)p==null&&(p={}),p=Object.assign({},x,p);else{var E=null;for(var w in x){var B=x[w];B!==void 0&&(u.includes(w)||(B!=null&&(p==null&&(p={}),E==null&&(E={}),E[w]=B),u.push(w),h=null))}E!=null&&(p=Object.assign(E,p))}}}var X=[d,p,c];return X}}var n=Lo.styleq=a();return n.factory=a,Lo}var Ab=Lb();function bt(...t){let[e,a,n]=Ab.styleq(t),i={};return e!=null&&e!==""&&(i.className=e),a!=null&&Object.keys(a).length>0&&(i.style=a),n!=null&&n!==""&&(i["data-style-src"]=n),i}var rR=Object.freeze({});var df=Ua(Kn(),1);var qx=0,Rh=1,Wx=2;var Ko=1,Xx=2,Ar=3,ai=0,va=1,On=2,Nn=0,ws=1,Dh=2,Ph=3,Uh=4,Yx=5;var Ni=100,Zx=101,Kx=102,Jx=103,Qx=104,jx=200,$x=201,e0=202,t0=203,Ou=204,Nu=205,a0=206,n0=207,i0=208,s0=209,r0=210,o0=211,l0=212,u0=213,c0=214,Fu=0,zu=1,ku=2,Rs=3,Hu=4,Vu=5,Gu=6,qu=7,Bh=0,f0=1,d0=2,vn=0,Oh=1,Nh=2,Fh=3,zh=4,kh=5,Hh=6,Vh=7;var Gh=300,Gi=301,Us=302,gc=303,xc=304,Jo=306,Wu=1e3,Rn=1001,Xu=1002,$t=1003,h0=1004;var Qo=1005;var ia=1006,vc=1007;var qi=1008;var ka=1009,qh=1010,Wh=1011,Tr=1012,yc=1013,yn=1014,_n=1015,Fn=1016,_c=1017,Sc=1018,Ir=1020,Xh=35902,Yh=35899,Zh=1021,Kh=1022,tn=1023,Dn=1026,Wi=1027,Jh=1028,Mc=1029,Xi=1030,bc=1031;var Cc=1033,jo=33776,$o=33777,el=33778,tl=33779,Lc=35840,Ac=35841,Tc=35842,Ic=35843,Ec=36196,wc=37492,Rc=37496,Dc=37488,Pc=37489,al=37490,Uc=37491,Bc=37808,Oc=37809,Nc=37810,Fc=37811,zc=37812,kc=37813,Hc=37814,Vc=37815,Gc=37816,qc=37817,Wc=37818,Xc=37819,Yc=37820,Zc=37821,Kc=36492,Jc=36494,Qc=36495,jc=36283,$c=36284,nl=36285,ef=36286;var Ro=2300,Yu=2301,Bu=2302,bh=2303,Ch=2400,Lh=2401,Ah=2402;var p0=3200;var Qh=0,m0=1,ii="",ga="srgb",Do="srgb-linear",Po="linear",at="srgb";var Ts=7680;var Th=519,g0=512,x0=513,v0=514,tf=515,y0=516,_0=517,af=518,S0=519,Ih=35044;var jh="300 es",xn=2e3,Uo=2001;function Tb(t){for(let e=t.length-1;e>=0;--e)if(t[e]>=65535)return!0;return!1}function Ib(t){return ArrayBuffer.isView(t)&&!(t instanceof DataView)}function Bo(t){return document.createElementNS("http://www.w3.org/1999/xhtml",t)}function M0(){let t=Bo("canvas");return t.style.display="block",t}var Ax={},Sr=null;function $h(...t){let e="THREE."+t.shift();Sr?Sr("log",e,...t):console.log(e,...t)}function b0(t){let e=t[0];if(typeof e=="string"&&e.startsWith("TSL:")){let a=t[1];a&&a.isStackTrace?t[0]+=" "+a.getLocation():t[1]='Stack trace not available. Enable "THREE.Node.captureStackTrace" to capture stack traces.'}return t}function Ae(...t){t=b0(t);let e="THREE."+t.shift();if(Sr)Sr("warn",e,...t);else{let a=t[0];a&&a.isStackTrace?console.warn(a.getError(e)):console.warn(e,...t)}}function Ee(...t){t=b0(t);let e="THREE."+t.shift();if(Sr)Sr("error",e,...t);else{let a=t[0];a&&a.isStackTrace?console.error(a.getError(e)):console.error(e,...t)}}function Es(...t){let e=t.join(" ");e in Ax||(Ax[e]=!0,Ae(...t))}function C0(t,e,a){return new Promise(function(n,i){function s(){switch(t.clientWaitSync(e,t.SYNC_FLUSH_COMMANDS_BIT,0)){case t.WAIT_FAILED:i();break;case t.TIMEOUT_EXPIRED:setTimeout(s,a);break;default:n()}}setTimeout(s,a)})}var L0={[Fu]:zu,[ku]:Gu,[Hu]:qu,[Rs]:Vu,[zu]:Fu,[Gu]:ku,[qu]:Hu,[Vu]:Rs},Pn=class{addEventListener(e,a){this._listeners===void 0&&(this._listeners={});let n=this._listeners;n[e]===void 0&&(n[e]=[]),n[e].indexOf(a)===-1&&n[e].push(a)}hasEventListener(e,a){let n=this._listeners;return n===void 0?!1:n[e]!==void 0&&n[e].indexOf(a)!==-1}removeEventListener(e,a){let n=this._listeners;if(n===void 0)return;let i=n[e];if(i!==void 0){let s=i.indexOf(a);s!==-1&&i.splice(s,1)}}dispatchEvent(e){let a=this._listeners;if(a===void 0)return;let n=a[e.type];if(n!==void 0){e.target=this;let i=n.slice(0);for(let s=0,r=i.length;s<r;s++)i[s].call(this,e);e.target=null}}},fa=["00","01","02","03","04","05","06","07","08","09","0a","0b","0c","0d","0e","0f","10","11","12","13","14","15","16","17","18","19","1a","1b","1c","1d","1e","1f","20","21","22","23","24","25","26","27","28","29","2a","2b","2c","2d","2e","2f","30","31","32","33","34","35","36","37","38","39","3a","3b","3c","3d","3e","3f","40","41","42","43","44","45","46","47","48","49","4a","4b","4c","4d","4e","4f","50","51","52","53","54","55","56","57","58","59","5a","5b","5c","5d","5e","5f","60","61","62","63","64","65","66","67","68","69","6a","6b","6c","6d","6e","6f","70","71","72","73","74","75","76","77","78","79","7a","7b","7c","7d","7e","7f","80","81","82","83","84","85","86","87","88","89","8a","8b","8c","8d","8e","8f","90","91","92","93","94","95","96","97","98","99","9a","9b","9c","9d","9e","9f","a0","a1","a2","a3","a4","a5","a6","a7","a8","a9","aa","ab","ac","ad","ae","af","b0","b1","b2","b3","b4","b5","b6","b7","b8","b9","ba","bb","bc","bd","be","bf","c0","c1","c2","c3","c4","c5","c6","c7","c8","c9","ca","cb","cc","cd","ce","cf","d0","d1","d2","d3","d4","d5","d6","d7","d8","d9","da","db","dc","dd","de","df","e0","e1","e2","e3","e4","e5","e6","e7","e8","e9","ea","eb","ec","ed","ee","ef","f0","f1","f2","f3","f4","f5","f6","f7","f8","f9","fa","fb","fc","fd","fe","ff"];var eh=Math.PI/180,Zu=180/Math.PI;function il(){let t=Math.random()*4294967295|0,e=Math.random()*4294967295|0,a=Math.random()*4294967295|0,n=Math.random()*4294967295|0;return(fa[t&255]+fa[t>>8&255]+fa[t>>16&255]+fa[t>>24&255]+"-"+fa[e&255]+fa[e>>8&255]+"-"+fa[e>>16&15|64]+fa[e>>24&255]+"-"+fa[a&63|128]+fa[a>>8&255]+"-"+fa[a>>16&255]+fa[a>>24&255]+fa[n&255]+fa[n>>8&255]+fa[n>>16&255]+fa[n>>24&255]).toLowerCase()}function Xe(t,e,a){return Math.max(e,Math.min(a,t))}function Eb(t,e){return(t%e+e)%e}function th(t,e,a){return(1-a)*t+a*e}function Ao(t,e){switch(e.constructor){case Float32Array:return t;case Uint32Array:return t/4294967295;case Uint16Array:return t/65535;case Uint8Array:return t/255;case Int32Array:return Math.max(t/2147483647,-1);case Int16Array:return Math.max(t/32767,-1);case Int8Array:return Math.max(t/127,-1);default:throw new Error("THREE.MathUtils: Invalid component type.")}}function ba(t,e){switch(e.constructor){case Float32Array:return t;case Uint32Array:return Math.round(t*4294967295);case Uint16Array:return Math.round(t*65535);case Uint8Array:return Math.round(t*255);case Int32Array:return Math.round(t*2147483647);case Int16Array:return Math.round(t*32767);case Int8Array:return Math.round(t*127);default:throw new Error("THREE.MathUtils: Invalid component type.")}}var qe=class t{static{t.prototype.isVector2=!0}constructor(e=0,a=0){this.x=e,this.y=a}get width(){return this.x}set width(e){this.x=e}get height(){return this.y}set height(e){this.y=e}set(e,a){return this.x=e,this.y=a,this}setScalar(e){return this.x=e,this.y=e,this}setX(e){return this.x=e,this}setY(e){return this.y=e,this}setComponent(e,a){switch(e){case 0:this.x=a;break;case 1:this.y=a;break;default:throw new Error("THREE.Vector2: index is out of range: "+e)}return this}getComponent(e){switch(e){case 0:return this.x;case 1:return this.y;default:throw new Error("THREE.Vector2: index is out of range: "+e)}}clone(){return new this.constructor(this.x,this.y)}copy(e){return this.x=e.x,this.y=e.y,this}add(e){return this.x+=e.x,this.y+=e.y,this}addScalar(e){return this.x+=e,this.y+=e,this}addVectors(e,a){return this.x=e.x+a.x,this.y=e.y+a.y,this}addScaledVector(e,a){return this.x+=e.x*a,this.y+=e.y*a,this}sub(e){return this.x-=e.x,this.y-=e.y,this}subScalar(e){return this.x-=e,this.y-=e,this}subVectors(e,a){return this.x=e.x-a.x,this.y=e.y-a.y,this}multiply(e){return this.x*=e.x,this.y*=e.y,this}multiplyScalar(e){return this.x*=e,this.y*=e,this}divide(e){return this.x/=e.x,this.y/=e.y,this}divideScalar(e){return this.multiplyScalar(1/e)}applyMatrix3(e){let a=this.x,n=this.y,i=e.elements;return this.x=i[0]*a+i[3]*n+i[6],this.y=i[1]*a+i[4]*n+i[7],this}min(e){return this.x=Math.min(this.x,e.x),this.y=Math.min(this.y,e.y),this}max(e){return this.x=Math.max(this.x,e.x),this.y=Math.max(this.y,e.y),this}clamp(e,a){return this.x=Xe(this.x,e.x,a.x),this.y=Xe(this.y,e.y,a.y),this}clampScalar(e,a){return this.x=Xe(this.x,e,a),this.y=Xe(this.y,e,a),this}clampLength(e,a){let n=this.length();return this.divideScalar(n||1).multiplyScalar(Xe(n,e,a))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this}negate(){return this.x=-this.x,this.y=-this.y,this}dot(e){return this.x*e.x+this.y*e.y}cross(e){return this.x*e.y-this.y*e.x}lengthSq(){return this.x*this.x+this.y*this.y}length(){return Math.sqrt(this.x*this.x+this.y*this.y)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)}normalize(){return this.divideScalar(this.length()||1)}angle(){return Math.atan2(-this.y,-this.x)+Math.PI}angleTo(e){let a=Math.sqrt(this.lengthSq()*e.lengthSq());if(a===0)return Math.PI/2;let n=this.dot(e)/a;return Math.acos(Xe(n,-1,1))}distanceTo(e){return Math.sqrt(this.distanceToSquared(e))}distanceToSquared(e){let a=this.x-e.x,n=this.y-e.y;return a*a+n*n}manhattanDistanceTo(e){return Math.abs(this.x-e.x)+Math.abs(this.y-e.y)}setLength(e){return this.normalize().multiplyScalar(e)}lerp(e,a){return this.x+=(e.x-this.x)*a,this.y+=(e.y-this.y)*a,this}lerpVectors(e,a,n){return this.x=e.x+(a.x-e.x)*n,this.y=e.y+(a.y-e.y)*n,this}equals(e){return e.x===this.x&&e.y===this.y}fromArray(e,a=0){return this.x=e[a],this.y=e[a+1],this}toArray(e=[],a=0){return e[a]=this.x,e[a+1]=this.y,e}fromBufferAttribute(e,a){return this.x=e.getX(a),this.y=e.getY(a),this}rotateAround(e,a){let n=Math.cos(a),i=Math.sin(a),s=this.x-e.x,r=this.y-e.y;return this.x=s*n-r*i+e.x,this.y=s*i+r*n+e.y,this}random(){return this.x=Math.random(),this.y=Math.random(),this}*[Symbol.iterator](){yield this.x,yield this.y}},Un=class{constructor(e=0,a=0,n=0,i=1){this.isQuaternion=!0,this._x=e,this._y=a,this._z=n,this._w=i}static slerpFlat(e,a,n,i,s,r,o){let l=n[i+0],u=n[i+1],d=n[i+2],p=n[i+3],c=s[r+0],h=s[r+1],v=s[r+2],b=s[r+3];if(p!==b||l!==c||u!==h||d!==v){let m=l*c+u*h+d*v+p*b;m<0&&(c=-c,h=-h,v=-v,b=-b,m=-m);let f=1-o;if(m<.9995){let x=Math.acos(m),S=Math.sin(x);f=Math.sin(f*x)/S,o=Math.sin(o*x)/S,l=l*f+c*o,u=u*f+h*o,d=d*f+v*o,p=p*f+b*o}else{l=l*f+c*o,u=u*f+h*o,d=d*f+v*o,p=p*f+b*o;let x=1/Math.sqrt(l*l+u*u+d*d+p*p);l*=x,u*=x,d*=x,p*=x}}e[a]=l,e[a+1]=u,e[a+2]=d,e[a+3]=p}static multiplyQuaternionsFlat(e,a,n,i,s,r){let o=n[i],l=n[i+1],u=n[i+2],d=n[i+3],p=s[r],c=s[r+1],h=s[r+2],v=s[r+3];return e[a]=o*v+d*p+l*h-u*c,e[a+1]=l*v+d*c+u*p-o*h,e[a+2]=u*v+d*h+o*c-l*p,e[a+3]=d*v-o*p-l*c-u*h,e}get x(){return this._x}set x(e){this._x=e,this._onChangeCallback()}get y(){return this._y}set y(e){this._y=e,this._onChangeCallback()}get z(){return this._z}set z(e){this._z=e,this._onChangeCallback()}get w(){return this._w}set w(e){this._w=e,this._onChangeCallback()}set(e,a,n,i){return this._x=e,this._y=a,this._z=n,this._w=i,this._onChangeCallback(),this}clone(){return new this.constructor(this._x,this._y,this._z,this._w)}copy(e){return this._x=e.x,this._y=e.y,this._z=e.z,this._w=e.w,this._onChangeCallback(),this}setFromEuler(e,a=!0){let n=e._x,i=e._y,s=e._z,r=e._order,o=Math.cos,l=Math.sin,u=o(n/2),d=o(i/2),p=o(s/2),c=l(n/2),h=l(i/2),v=l(s/2);switch(r){case"XYZ":this._x=c*d*p+u*h*v,this._y=u*h*p-c*d*v,this._z=u*d*v+c*h*p,this._w=u*d*p-c*h*v;break;case"YXZ":this._x=c*d*p+u*h*v,this._y=u*h*p-c*d*v,this._z=u*d*v-c*h*p,this._w=u*d*p+c*h*v;break;case"ZXY":this._x=c*d*p-u*h*v,this._y=u*h*p+c*d*v,this._z=u*d*v+c*h*p,this._w=u*d*p-c*h*v;break;case"ZYX":this._x=c*d*p-u*h*v,this._y=u*h*p+c*d*v,this._z=u*d*v-c*h*p,this._w=u*d*p+c*h*v;break;case"YZX":this._x=c*d*p+u*h*v,this._y=u*h*p+c*d*v,this._z=u*d*v-c*h*p,this._w=u*d*p-c*h*v;break;case"XZY":this._x=c*d*p-u*h*v,this._y=u*h*p-c*d*v,this._z=u*d*v+c*h*p,this._w=u*d*p+c*h*v;break;default:Ae("Quaternion: .setFromEuler() encountered an unknown order: "+r)}return a===!0&&this._onChangeCallback(),this}setFromAxisAngle(e,a){let n=a/2,i=Math.sin(n);return this._x=e.x*i,this._y=e.y*i,this._z=e.z*i,this._w=Math.cos(n),this._onChangeCallback(),this}setFromRotationMatrix(e){let a=e.elements,n=a[0],i=a[4],s=a[8],r=a[1],o=a[5],l=a[9],u=a[2],d=a[6],p=a[10],c=n+o+p;if(c>0){let h=.5/Math.sqrt(c+1);this._w=.25/h,this._x=(d-l)*h,this._y=(s-u)*h,this._z=(r-i)*h}else if(n>o&&n>p){let h=2*Math.sqrt(1+n-o-p);this._w=(d-l)/h,this._x=.25*h,this._y=(i+r)/h,this._z=(s+u)/h}else if(o>p){let h=2*Math.sqrt(1+o-n-p);this._w=(s-u)/h,this._x=(i+r)/h,this._y=.25*h,this._z=(l+d)/h}else{let h=2*Math.sqrt(1+p-n-o);this._w=(r-i)/h,this._x=(s+u)/h,this._y=(l+d)/h,this._z=.25*h}return this._onChangeCallback(),this}setFromUnitVectors(e,a){let n=e.dot(a)+1;return n<1e-8?(n=0,Math.abs(e.x)>Math.abs(e.z)?(this._x=-e.y,this._y=e.x,this._z=0,this._w=n):(this._x=0,this._y=-e.z,this._z=e.y,this._w=n)):(this._x=e.y*a.z-e.z*a.y,this._y=e.z*a.x-e.x*a.z,this._z=e.x*a.y-e.y*a.x,this._w=n),this.normalize()}angleTo(e){return 2*Math.acos(Math.abs(Xe(this.dot(e),-1,1)))}rotateTowards(e,a){let n=this.angleTo(e);if(n===0)return this;let i=Math.min(1,a/n);return this.slerp(e,i),this}identity(){return this.set(0,0,0,1)}invert(){return this.conjugate()}conjugate(){return this._x*=-1,this._y*=-1,this._z*=-1,this._onChangeCallback(),this}dot(e){return this._x*e._x+this._y*e._y+this._z*e._z+this._w*e._w}lengthSq(){return this._x*this._x+this._y*this._y+this._z*this._z+this._w*this._w}length(){return Math.sqrt(this._x*this._x+this._y*this._y+this._z*this._z+this._w*this._w)}normalize(){let e=this.length();return e===0?(this._x=0,this._y=0,this._z=0,this._w=1):(e=1/e,this._x=this._x*e,this._y=this._y*e,this._z=this._z*e,this._w=this._w*e),this._onChangeCallback(),this}multiply(e){return this.multiplyQuaternions(this,e)}premultiply(e){return this.multiplyQuaternions(e,this)}multiplyQuaternions(e,a){let n=e._x,i=e._y,s=e._z,r=e._w,o=a._x,l=a._y,u=a._z,d=a._w;return this._x=n*d+r*o+i*u-s*l,this._y=i*d+r*l+s*o-n*u,this._z=s*d+r*u+n*l-i*o,this._w=r*d-n*o-i*l-s*u,this._onChangeCallback(),this}slerp(e,a){let n=e._x,i=e._y,s=e._z,r=e._w,o=this.dot(e);o<0&&(n=-n,i=-i,s=-s,r=-r,o=-o);let l=1-a;if(o<.9995){let u=Math.acos(o),d=Math.sin(u);l=Math.sin(l*u)/d,a=Math.sin(a*u)/d,this._x=this._x*l+n*a,this._y=this._y*l+i*a,this._z=this._z*l+s*a,this._w=this._w*l+r*a,this._onChangeCallback()}else this._x=this._x*l+n*a,this._y=this._y*l+i*a,this._z=this._z*l+s*a,this._w=this._w*l+r*a,this.normalize();return this}slerpQuaternions(e,a,n){return this.copy(e).slerp(a,n)}random(){let e=2*Math.PI*Math.random(),a=2*Math.PI*Math.random(),n=Math.random(),i=Math.sqrt(1-n),s=Math.sqrt(n);return this.set(i*Math.sin(e),i*Math.cos(e),s*Math.sin(a),s*Math.cos(a))}equals(e){return e._x===this._x&&e._y===this._y&&e._z===this._z&&e._w===this._w}fromArray(e,a=0){return this._x=e[a],this._y=e[a+1],this._z=e[a+2],this._w=e[a+3],this._onChangeCallback(),this}toArray(e=[],a=0){return e[a]=this._x,e[a+1]=this._y,e[a+2]=this._z,e[a+3]=this._w,e}fromBufferAttribute(e,a){return this._x=e.getX(a),this._y=e.getY(a),this._z=e.getZ(a),this._w=e.getW(a),this._onChangeCallback(),this}toJSON(){return this.toArray()}_onChange(e){return this._onChangeCallback=e,this}_onChangeCallback(){}*[Symbol.iterator](){yield this._x,yield this._y,yield this._z,yield this._w}},F=class t{static{t.prototype.isVector3=!0}constructor(e=0,a=0,n=0){this.x=e,this.y=a,this.z=n}set(e,a,n){return n===void 0&&(n=this.z),this.x=e,this.y=a,this.z=n,this}setScalar(e){return this.x=e,this.y=e,this.z=e,this}setX(e){return this.x=e,this}setY(e){return this.y=e,this}setZ(e){return this.z=e,this}setComponent(e,a){switch(e){case 0:this.x=a;break;case 1:this.y=a;break;case 2:this.z=a;break;default:throw new Error("THREE.Vector3: index is out of range: "+e)}return this}getComponent(e){switch(e){case 0:return this.x;case 1:return this.y;case 2:return this.z;default:throw new Error("THREE.Vector3: index is out of range: "+e)}}clone(){return new this.constructor(this.x,this.y,this.z)}copy(e){return this.x=e.x,this.y=e.y,this.z=e.z,this}add(e){return this.x+=e.x,this.y+=e.y,this.z+=e.z,this}addScalar(e){return this.x+=e,this.y+=e,this.z+=e,this}addVectors(e,a){return this.x=e.x+a.x,this.y=e.y+a.y,this.z=e.z+a.z,this}addScaledVector(e,a){return this.x+=e.x*a,this.y+=e.y*a,this.z+=e.z*a,this}sub(e){return this.x-=e.x,this.y-=e.y,this.z-=e.z,this}subScalar(e){return this.x-=e,this.y-=e,this.z-=e,this}subVectors(e,a){return this.x=e.x-a.x,this.y=e.y-a.y,this.z=e.z-a.z,this}multiply(e){return this.x*=e.x,this.y*=e.y,this.z*=e.z,this}multiplyScalar(e){return this.x*=e,this.y*=e,this.z*=e,this}multiplyVectors(e,a){return this.x=e.x*a.x,this.y=e.y*a.y,this.z=e.z*a.z,this}applyEuler(e){return this.applyQuaternion(Tx.setFromEuler(e))}applyAxisAngle(e,a){return this.applyQuaternion(Tx.setFromAxisAngle(e,a))}applyMatrix3(e){let a=this.x,n=this.y,i=this.z,s=e.elements;return this.x=s[0]*a+s[3]*n+s[6]*i,this.y=s[1]*a+s[4]*n+s[7]*i,this.z=s[2]*a+s[5]*n+s[8]*i,this}applyNormalMatrix(e){return this.applyMatrix3(e).normalize()}applyMatrix4(e){let a=this.x,n=this.y,i=this.z,s=e.elements,r=1/(s[3]*a+s[7]*n+s[11]*i+s[15]);return this.x=(s[0]*a+s[4]*n+s[8]*i+s[12])*r,this.y=(s[1]*a+s[5]*n+s[9]*i+s[13])*r,this.z=(s[2]*a+s[6]*n+s[10]*i+s[14])*r,this}applyQuaternion(e){let a=this.x,n=this.y,i=this.z,s=e.x,r=e.y,o=e.z,l=e.w,u=2*(r*i-o*n),d=2*(o*a-s*i),p=2*(s*n-r*a);return this.x=a+l*u+r*p-o*d,this.y=n+l*d+o*u-s*p,this.z=i+l*p+s*d-r*u,this}project(e){return this.applyMatrix4(e.matrixWorldInverse).applyMatrix4(e.projectionMatrix)}unproject(e){return this.applyMatrix4(e.projectionMatrixInverse).applyMatrix4(e.matrixWorld)}transformDirection(e){let a=this.x,n=this.y,i=this.z,s=e.elements;return this.x=s[0]*a+s[4]*n+s[8]*i,this.y=s[1]*a+s[5]*n+s[9]*i,this.z=s[2]*a+s[6]*n+s[10]*i,this.normalize()}divide(e){return this.x/=e.x,this.y/=e.y,this.z/=e.z,this}divideScalar(e){return this.multiplyScalar(1/e)}min(e){return this.x=Math.min(this.x,e.x),this.y=Math.min(this.y,e.y),this.z=Math.min(this.z,e.z),this}max(e){return this.x=Math.max(this.x,e.x),this.y=Math.max(this.y,e.y),this.z=Math.max(this.z,e.z),this}clamp(e,a){return this.x=Xe(this.x,e.x,a.x),this.y=Xe(this.y,e.y,a.y),this.z=Xe(this.z,e.z,a.z),this}clampScalar(e,a){return this.x=Xe(this.x,e,a),this.y=Xe(this.y,e,a),this.z=Xe(this.z,e,a),this}clampLength(e,a){let n=this.length();return this.divideScalar(n||1).multiplyScalar(Xe(n,e,a))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this.z=Math.floor(this.z),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this.z=Math.ceil(this.z),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this.z=Math.round(this.z),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this.z=Math.trunc(this.z),this}negate(){return this.x=-this.x,this.y=-this.y,this.z=-this.z,this}dot(e){return this.x*e.x+this.y*e.y+this.z*e.z}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z}length(){return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)+Math.abs(this.z)}normalize(){return this.divideScalar(this.length()||1)}setLength(e){return this.normalize().multiplyScalar(e)}lerp(e,a){return this.x+=(e.x-this.x)*a,this.y+=(e.y-this.y)*a,this.z+=(e.z-this.z)*a,this}lerpVectors(e,a,n){return this.x=e.x+(a.x-e.x)*n,this.y=e.y+(a.y-e.y)*n,this.z=e.z+(a.z-e.z)*n,this}cross(e){return this.crossVectors(this,e)}crossVectors(e,a){let n=e.x,i=e.y,s=e.z,r=a.x,o=a.y,l=a.z;return this.x=i*l-s*o,this.y=s*r-n*l,this.z=n*o-i*r,this}projectOnVector(e){let a=e.lengthSq();if(a===0)return this.set(0,0,0);let n=e.dot(this)/a;return this.copy(e).multiplyScalar(n)}projectOnPlane(e){return ah.copy(this).projectOnVector(e),this.sub(ah)}reflect(e){return this.sub(ah.copy(e).multiplyScalar(2*this.dot(e)))}angleTo(e){let a=Math.sqrt(this.lengthSq()*e.lengthSq());if(a===0)return Math.PI/2;let n=this.dot(e)/a;return Math.acos(Xe(n,-1,1))}distanceTo(e){return Math.sqrt(this.distanceToSquared(e))}distanceToSquared(e){let a=this.x-e.x,n=this.y-e.y,i=this.z-e.z;return a*a+n*n+i*i}manhattanDistanceTo(e){return Math.abs(this.x-e.x)+Math.abs(this.y-e.y)+Math.abs(this.z-e.z)}setFromSpherical(e){return this.setFromSphericalCoords(e.radius,e.phi,e.theta)}setFromSphericalCoords(e,a,n){let i=Math.sin(a)*e;return this.x=i*Math.sin(n),this.y=Math.cos(a)*e,this.z=i*Math.cos(n),this}setFromCylindrical(e){return this.setFromCylindricalCoords(e.radius,e.theta,e.y)}setFromCylindricalCoords(e,a,n){return this.x=e*Math.sin(a),this.y=n,this.z=e*Math.cos(a),this}setFromMatrixPosition(e){let a=e.elements;return this.x=a[12],this.y=a[13],this.z=a[14],this}setFromMatrixScale(e){let a=this.setFromMatrixColumn(e,0).length(),n=this.setFromMatrixColumn(e,1).length(),i=this.setFromMatrixColumn(e,2).length();return this.x=a,this.y=n,this.z=i,this}setFromMatrixColumn(e,a){return this.fromArray(e.elements,a*4)}setFromMatrix3Column(e,a){return this.fromArray(e.elements,a*3)}setFromEuler(e){return this.x=e._x,this.y=e._y,this.z=e._z,this}setFromColor(e){return this.x=e.r,this.y=e.g,this.z=e.b,this}equals(e){return e.x===this.x&&e.y===this.y&&e.z===this.z}fromArray(e,a=0){return this.x=e[a],this.y=e[a+1],this.z=e[a+2],this}toArray(e=[],a=0){return e[a]=this.x,e[a+1]=this.y,e[a+2]=this.z,e}fromBufferAttribute(e,a){return this.x=e.getX(a),this.y=e.getY(a),this.z=e.getZ(a),this}random(){return this.x=Math.random(),this.y=Math.random(),this.z=Math.random(),this}randomDirection(){let e=Math.random()*Math.PI*2,a=Math.random()*2-1,n=Math.sqrt(1-a*a);return this.x=n*Math.cos(e),this.y=a,this.z=n*Math.sin(e),this}*[Symbol.iterator](){yield this.x,yield this.y,yield this.z}},ah=new F,Tx=new Un,De=class t{static{t.prototype.isMatrix3=!0}constructor(e,a,n,i,s,r,o,l,u){this.elements=[1,0,0,0,1,0,0,0,1],e!==void 0&&this.set(e,a,n,i,s,r,o,l,u)}set(e,a,n,i,s,r,o,l,u){let d=this.elements;return d[0]=e,d[1]=i,d[2]=o,d[3]=a,d[4]=s,d[5]=l,d[6]=n,d[7]=r,d[8]=u,this}identity(){return this.set(1,0,0,0,1,0,0,0,1),this}copy(e){let a=this.elements,n=e.elements;return a[0]=n[0],a[1]=n[1],a[2]=n[2],a[3]=n[3],a[4]=n[4],a[5]=n[5],a[6]=n[6],a[7]=n[7],a[8]=n[8],this}extractBasis(e,a,n){return e.setFromMatrix3Column(this,0),a.setFromMatrix3Column(this,1),n.setFromMatrix3Column(this,2),this}setFromMatrix4(e){let a=e.elements;return this.set(a[0],a[4],a[8],a[1],a[5],a[9],a[2],a[6],a[10]),this}multiply(e){return this.multiplyMatrices(this,e)}premultiply(e){return this.multiplyMatrices(e,this)}multiplyMatrices(e,a){let n=e.elements,i=a.elements,s=this.elements,r=n[0],o=n[3],l=n[6],u=n[1],d=n[4],p=n[7],c=n[2],h=n[5],v=n[8],b=i[0],m=i[3],f=i[6],x=i[1],S=i[4],_=i[7],L=i[2],C=i[5],T=i[8];return s[0]=r*b+o*x+l*L,s[3]=r*m+o*S+l*C,s[6]=r*f+o*_+l*T,s[1]=u*b+d*x+p*L,s[4]=u*m+d*S+p*C,s[7]=u*f+d*_+p*T,s[2]=c*b+h*x+v*L,s[5]=c*m+h*S+v*C,s[8]=c*f+h*_+v*T,this}multiplyScalar(e){let a=this.elements;return a[0]*=e,a[3]*=e,a[6]*=e,a[1]*=e,a[4]*=e,a[7]*=e,a[2]*=e,a[5]*=e,a[8]*=e,this}determinant(){let e=this.elements,a=e[0],n=e[1],i=e[2],s=e[3],r=e[4],o=e[5],l=e[6],u=e[7],d=e[8];return a*r*d-a*o*u-n*s*d+n*o*l+i*s*u-i*r*l}invert(){let e=this.elements,a=e[0],n=e[1],i=e[2],s=e[3],r=e[4],o=e[5],l=e[6],u=e[7],d=e[8],p=d*r-o*u,c=o*l-d*s,h=u*s-r*l,v=a*p+n*c+i*h;if(v===0)return this.set(0,0,0,0,0,0,0,0,0);let b=1/v;return e[0]=p*b,e[1]=(i*u-d*n)*b,e[2]=(o*n-i*r)*b,e[3]=c*b,e[4]=(d*a-i*l)*b,e[5]=(i*s-o*a)*b,e[6]=h*b,e[7]=(n*l-u*a)*b,e[8]=(r*a-n*s)*b,this}transpose(){let e,a=this.elements;return e=a[1],a[1]=a[3],a[3]=e,e=a[2],a[2]=a[6],a[6]=e,e=a[5],a[5]=a[7],a[7]=e,this}getNormalMatrix(e){return this.setFromMatrix4(e).invert().transpose()}transposeIntoArray(e){let a=this.elements;return e[0]=a[0],e[1]=a[3],e[2]=a[6],e[3]=a[1],e[4]=a[4],e[5]=a[7],e[6]=a[2],e[7]=a[5],e[8]=a[8],this}setUvTransform(e,a,n,i,s,r,o){let l=Math.cos(s),u=Math.sin(s);return this.set(n*l,n*u,-n*(l*r+u*o)+r+e,-i*u,i*l,-i*(-u*r+l*o)+o+a,0,0,1),this}scale(e,a){return Es("Matrix3: .scale() is deprecated. Use .makeScale() instead."),this.premultiply(nh.makeScale(e,a)),this}rotate(e){return Es("Matrix3: .rotate() is deprecated. Use .makeRotation() instead."),this.premultiply(nh.makeRotation(-e)),this}translate(e,a){return Es("Matrix3: .translate() is deprecated. Use .makeTranslation() instead."),this.premultiply(nh.makeTranslation(e,a)),this}makeTranslation(e,a){return e.isVector2?this.set(1,0,e.x,0,1,e.y,0,0,1):this.set(1,0,e,0,1,a,0,0,1),this}makeRotation(e){let a=Math.cos(e),n=Math.sin(e);return this.set(a,-n,0,n,a,0,0,0,1),this}makeScale(e,a){return this.set(e,0,0,0,a,0,0,0,1),this}equals(e){let a=this.elements,n=e.elements;for(let i=0;i<9;i++)if(a[i]!==n[i])return!1;return!0}fromArray(e,a=0){for(let n=0;n<9;n++)this.elements[n]=e[n+a];return this}toArray(e=[],a=0){let n=this.elements;return e[a]=n[0],e[a+1]=n[1],e[a+2]=n[2],e[a+3]=n[3],e[a+4]=n[4],e[a+5]=n[5],e[a+6]=n[6],e[a+7]=n[7],e[a+8]=n[8],e}clone(){return new this.constructor().fromArray(this.elements)}},nh=new De,Ix=new De().set(.4123908,.3575843,.1804808,.212639,.7151687,.0721923,.0193308,.1191948,.9505322),Ex=new De().set(3.2409699,-1.5373832,-.4986108,-.9692436,1.8759675,.0415551,.0556301,-.203977,1.0569715);function wb(){let t={enabled:!0,workingColorSpace:Do,spaces:{},convert:function(i,s,r){return this.enabled===!1||s===r||!s||!r||(this.spaces[s].transfer===at&&(i.r=ti(i.r),i.g=ti(i.g),i.b=ti(i.b)),this.spaces[s].primaries!==this.spaces[r].primaries&&(i.applyMatrix3(this.spaces[s].toXYZ),i.applyMatrix3(this.spaces[r].fromXYZ)),this.spaces[r].transfer===at&&(i.r=_r(i.r),i.g=_r(i.g),i.b=_r(i.b))),i},workingToColorSpace:function(i,s){return this.convert(i,this.workingColorSpace,s)},colorSpaceToWorking:function(i,s){return this.convert(i,s,this.workingColorSpace)},getPrimaries:function(i){return this.spaces[i].primaries},getTransfer:function(i){return i===ii?Po:this.spaces[i].transfer},getToneMappingMode:function(i){return this.spaces[i].outputColorSpaceConfig.toneMappingMode||"standard"},getLuminanceCoefficients:function(i,s=this.workingColorSpace){return i.fromArray(this.spaces[s].luminanceCoefficients)},define:function(i){Object.assign(this.spaces,i)},_getMatrix:function(i,s,r){return i.copy(this.spaces[s].toXYZ).multiply(this.spaces[r].fromXYZ)},_getDrawingBufferColorSpace:function(i){return this.spaces[i].outputColorSpaceConfig.drawingBufferColorSpace},_getUnpackColorSpace:function(i=this.workingColorSpace){return this.spaces[i].workingColorSpaceConfig.unpackColorSpace},fromWorkingColorSpace:function(i,s){return Es("ColorManagement: .fromWorkingColorSpace() has been renamed to .workingToColorSpace()."),t.workingToColorSpace(i,s)},toWorkingColorSpace:function(i,s){return Es("ColorManagement: .toWorkingColorSpace() has been renamed to .colorSpaceToWorking()."),t.colorSpaceToWorking(i,s)}},e=[.64,.33,.3,.6,.15,.06],a=[.2126,.7152,.0722],n=[.3127,.329];return t.define({[Do]:{primaries:e,whitePoint:n,transfer:Po,toXYZ:Ix,fromXYZ:Ex,luminanceCoefficients:a,workingColorSpaceConfig:{unpackColorSpace:ga},outputColorSpaceConfig:{drawingBufferColorSpace:ga}},[ga]:{primaries:e,whitePoint:n,transfer:at,toXYZ:Ix,fromXYZ:Ex,luminanceCoefficients:a,outputColorSpaceConfig:{drawingBufferColorSpace:ga}}}),t}var Ge=wb();function ti(t){return t<.04045?t*.0773993808:Math.pow(t*.9478672986+.0521327014,2.4)}function _r(t){return t<.0031308?t*12.92:1.055*Math.pow(t,.41666)-.055}var lr,Ku=class{static getDataURL(e,a="image/png"){if(/^data:/i.test(e.src)||typeof HTMLCanvasElement>"u")return e.src;let n;if(e instanceof HTMLCanvasElement)n=e;else{lr===void 0&&(lr=Bo("canvas")),lr.width=e.width,lr.height=e.height;let i=lr.getContext("2d");e instanceof ImageData?i.putImageData(e,0,0):i.drawImage(e,0,0,e.width,e.height),n=lr}return n.toDataURL(a)}static sRGBToLinear(e){if(typeof HTMLImageElement<"u"&&e instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&e instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&e instanceof ImageBitmap){let a=Bo("canvas");a.width=e.width,a.height=e.height;let n=a.getContext("2d");n.drawImage(e,0,0,e.width,e.height);let i=n.getImageData(0,0,e.width,e.height),s=i.data;for(let r=0;r<s.length;r++)s[r]=ti(s[r]/255)*255;return n.putImageData(i,0,0),a}else if(e.data){let a=e.data.slice(0);for(let n=0;n<a.length;n++)a instanceof Uint8Array||a instanceof Uint8ClampedArray?a[n]=Math.floor(ti(a[n]/255)*255):a[n]=ti(a[n]);return{data:a,width:e.width,height:e.height}}else return Ae("ImageUtils.sRGBToLinear(): Unsupported image type. No color space conversion applied."),e}},Rb=0,Mr=class{constructor(e=null){this.isSource=!0,Object.defineProperty(this,"id",{value:Rb++}),this.uuid=il(),this.data=e,this.dataReady=!0,this.version=0}getSize(e){let a=this.data;return typeof HTMLVideoElement<"u"&&a instanceof HTMLVideoElement?e.set(a.videoWidth,a.videoHeight,0):typeof VideoFrame<"u"&&a instanceof VideoFrame?e.set(a.displayWidth,a.displayHeight,0):a!==null?e.set(a.width,a.height,a.depth||0):e.set(0,0,0),e}set needsUpdate(e){e===!0&&this.version++}toJSON(e){let a=e===void 0||typeof e=="string";if(!a&&e.images[this.uuid]!==void 0)return e.images[this.uuid];let n={uuid:this.uuid,url:""},i=this.data;if(i!==null){let s;if(Array.isArray(i)){s=[];for(let r=0,o=i.length;r<o;r++)i[r].isDataTexture?s.push(ih(i[r].image)):s.push(ih(i[r]))}else s=ih(i);n.url=s}return a||(e.images[this.uuid]=n),n}};function ih(t){return typeof HTMLImageElement<"u"&&t instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&t instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&t instanceof ImageBitmap?Ku.getDataURL(t):t.data?{data:Array.from(t.data),width:t.width,height:t.height,type:t.data.constructor.name}:(Ae("Texture: Unable to serialize Texture."),{})}var Db=0,sh=new F,Ca=class t extends Pn{constructor(e=t.DEFAULT_IMAGE,a=t.DEFAULT_MAPPING,n=Rn,i=Rn,s=ia,r=qi,o=tn,l=ka,u=t.DEFAULT_ANISOTROPY,d=ii){super(),this.isTexture=!0,Object.defineProperty(this,"id",{value:Db++}),this.uuid=il(),this.name="",this.source=new Mr(e),this.mipmaps=[],this.mapping=a,this.channel=0,this.wrapS=n,this.wrapT=i,this.magFilter=s,this.minFilter=r,this.anisotropy=u,this.format=o,this.internalFormat=null,this.type=l,this.offset=new qe(0,0),this.repeat=new qe(1,1),this.center=new qe(0,0),this.rotation=0,this.matrixAutoUpdate=!0,this.matrix=new De,this.generateMipmaps=!0,this.premultiplyAlpha=!1,this.flipY=!0,this.unpackAlignment=4,this.colorSpace=d,this.userData={},this.updateRanges=[],this.version=0,this.onUpdate=null,this.renderTarget=null,this.isRenderTargetTexture=!1,this.isArrayTexture=!!(e&&e.depth&&e.depth>1),this.pmremVersion=0,this.normalized=!1}get width(){return this.source.getSize(sh).x}get height(){return this.source.getSize(sh).y}get depth(){return this.source.getSize(sh).z}get image(){return this.source.data}set image(e){this.source.data=e}updateMatrix(){this.matrix.setUvTransform(this.offset.x,this.offset.y,this.repeat.x,this.repeat.y,this.rotation,this.center.x,this.center.y)}addUpdateRange(e,a){this.updateRanges.push({start:e,count:a})}clearUpdateRanges(){this.updateRanges.length=0}clone(){return new this.constructor().copy(this)}copy(e){return this.name=e.name,this.source=e.source,this.mipmaps=e.mipmaps.slice(0),this.mapping=e.mapping,this.channel=e.channel,this.wrapS=e.wrapS,this.wrapT=e.wrapT,this.magFilter=e.magFilter,this.minFilter=e.minFilter,this.anisotropy=e.anisotropy,this.format=e.format,this.internalFormat=e.internalFormat,this.type=e.type,this.normalized=e.normalized,this.offset.copy(e.offset),this.repeat.copy(e.repeat),this.center.copy(e.center),this.rotation=e.rotation,this.matrixAutoUpdate=e.matrixAutoUpdate,this.matrix.copy(e.matrix),this.generateMipmaps=e.generateMipmaps,this.premultiplyAlpha=e.premultiplyAlpha,this.flipY=e.flipY,this.unpackAlignment=e.unpackAlignment,this.colorSpace=e.colorSpace,this.renderTarget=e.renderTarget,this.isRenderTargetTexture=e.isRenderTargetTexture,this.isArrayTexture=e.isArrayTexture,this.userData=JSON.parse(JSON.stringify(e.userData)),this.needsUpdate=!0,this}setValues(e){for(let a in e){let n=e[a];if(n===void 0){Ae(`Texture.setValues(): parameter '${a}' has value of undefined.`);continue}let i=this[a];if(i===void 0){Ae(`Texture.setValues(): property '${a}' does not exist.`);continue}i&&n&&i.isVector2&&n.isVector2||i&&n&&i.isVector3&&n.isVector3||i&&n&&i.isMatrix3&&n.isMatrix3?i.copy(n):this[a]=n}}toJSON(e){let a=e===void 0||typeof e=="string";if(!a&&e.textures[this.uuid]!==void 0)return e.textures[this.uuid];let n={metadata:{version:4.7,type:"Texture",generator:"Texture.toJSON"},uuid:this.uuid,name:this.name,image:this.source.toJSON(e).uuid,mapping:this.mapping,channel:this.channel,repeat:[this.repeat.x,this.repeat.y],offset:[this.offset.x,this.offset.y],center:[this.center.x,this.center.y],rotation:this.rotation,wrap:[this.wrapS,this.wrapT],format:this.format,internalFormat:this.internalFormat,type:this.type,normalized:this.normalized,colorSpace:this.colorSpace,minFilter:this.minFilter,magFilter:this.magFilter,anisotropy:this.anisotropy,flipY:this.flipY,generateMipmaps:this.generateMipmaps,premultiplyAlpha:this.premultiplyAlpha,unpackAlignment:this.unpackAlignment};return Object.keys(this.userData).length>0&&(n.userData=this.userData),a||(e.textures[this.uuid]=n),n}dispose(){this.dispatchEvent({type:"dispose"})}transformUv(e){if(this.mapping!==Gh)return e;if(e.applyMatrix3(this.matrix),e.x<0||e.x>1)switch(this.wrapS){case Wu:e.x=e.x-Math.floor(e.x);break;case Rn:e.x=e.x<0?0:1;break;case Xu:Math.abs(Math.floor(e.x)%2)===1?e.x=Math.ceil(e.x)-e.x:e.x=e.x-Math.floor(e.x);break}if(e.y<0||e.y>1)switch(this.wrapT){case Wu:e.y=e.y-Math.floor(e.y);break;case Rn:e.y=e.y<0?0:1;break;case Xu:Math.abs(Math.floor(e.y)%2)===1?e.y=Math.ceil(e.y)-e.y:e.y=e.y-Math.floor(e.y);break}return this.flipY&&(e.y=1-e.y),e}set needsUpdate(e){e===!0&&(this.version++,this.source.needsUpdate=!0)}set needsPMREMUpdate(e){e===!0&&this.pmremVersion++}};Ca.DEFAULT_IMAGE=null;Ca.DEFAULT_MAPPING=Gh;Ca.DEFAULT_ANISOTROPY=1;var At=class t{static{t.prototype.isVector4=!0}constructor(e=0,a=0,n=0,i=1){this.x=e,this.y=a,this.z=n,this.w=i}get width(){return this.z}set width(e){this.z=e}get height(){return this.w}set height(e){this.w=e}set(e,a,n,i){return this.x=e,this.y=a,this.z=n,this.w=i,this}setScalar(e){return this.x=e,this.y=e,this.z=e,this.w=e,this}setX(e){return this.x=e,this}setY(e){return this.y=e,this}setZ(e){return this.z=e,this}setW(e){return this.w=e,this}setComponent(e,a){switch(e){case 0:this.x=a;break;case 1:this.y=a;break;case 2:this.z=a;break;case 3:this.w=a;break;default:throw new Error("THREE.Vector4: index is out of range: "+e)}return this}getComponent(e){switch(e){case 0:return this.x;case 1:return this.y;case 2:return this.z;case 3:return this.w;default:throw new Error("THREE.Vector4: index is out of range: "+e)}}clone(){return new this.constructor(this.x,this.y,this.z,this.w)}copy(e){return this.x=e.x,this.y=e.y,this.z=e.z,this.w=e.w!==void 0?e.w:1,this}add(e){return this.x+=e.x,this.y+=e.y,this.z+=e.z,this.w+=e.w,this}addScalar(e){return this.x+=e,this.y+=e,this.z+=e,this.w+=e,this}addVectors(e,a){return this.x=e.x+a.x,this.y=e.y+a.y,this.z=e.z+a.z,this.w=e.w+a.w,this}addScaledVector(e,a){return this.x+=e.x*a,this.y+=e.y*a,this.z+=e.z*a,this.w+=e.w*a,this}sub(e){return this.x-=e.x,this.y-=e.y,this.z-=e.z,this.w-=e.w,this}subScalar(e){return this.x-=e,this.y-=e,this.z-=e,this.w-=e,this}subVectors(e,a){return this.x=e.x-a.x,this.y=e.y-a.y,this.z=e.z-a.z,this.w=e.w-a.w,this}multiply(e){return this.x*=e.x,this.y*=e.y,this.z*=e.z,this.w*=e.w,this}multiplyScalar(e){return this.x*=e,this.y*=e,this.z*=e,this.w*=e,this}applyMatrix4(e){let a=this.x,n=this.y,i=this.z,s=this.w,r=e.elements;return this.x=r[0]*a+r[4]*n+r[8]*i+r[12]*s,this.y=r[1]*a+r[5]*n+r[9]*i+r[13]*s,this.z=r[2]*a+r[6]*n+r[10]*i+r[14]*s,this.w=r[3]*a+r[7]*n+r[11]*i+r[15]*s,this}divide(e){return this.x/=e.x,this.y/=e.y,this.z/=e.z,this.w/=e.w,this}divideScalar(e){return this.multiplyScalar(1/e)}setAxisAngleFromQuaternion(e){this.w=2*Math.acos(e.w);let a=Math.sqrt(1-e.w*e.w);return a<1e-4?(this.x=1,this.y=0,this.z=0):(this.x=e.x/a,this.y=e.y/a,this.z=e.z/a),this}setAxisAngleFromRotationMatrix(e){let a,n,i,s,l=e.elements,u=l[0],d=l[4],p=l[8],c=l[1],h=l[5],v=l[9],b=l[2],m=l[6],f=l[10];if(Math.abs(d-c)<.01&&Math.abs(p-b)<.01&&Math.abs(v-m)<.01){if(Math.abs(d+c)<.1&&Math.abs(p+b)<.1&&Math.abs(v+m)<.1&&Math.abs(u+h+f-3)<.1)return this.set(1,0,0,0),this;a=Math.PI;let S=(u+1)/2,_=(h+1)/2,L=(f+1)/2,C=(d+c)/4,T=(p+b)/4,y=(v+m)/4;return S>_&&S>L?S<.01?(n=0,i=.707106781,s=.707106781):(n=Math.sqrt(S),i=C/n,s=T/n):_>L?_<.01?(n=.707106781,i=0,s=.707106781):(i=Math.sqrt(_),n=C/i,s=y/i):L<.01?(n=.707106781,i=.707106781,s=0):(s=Math.sqrt(L),n=T/s,i=y/s),this.set(n,i,s,a),this}let x=Math.sqrt((m-v)*(m-v)+(p-b)*(p-b)+(c-d)*(c-d));return Math.abs(x)<.001&&(x=1),this.x=(m-v)/x,this.y=(p-b)/x,this.z=(c-d)/x,this.w=Math.acos((u+h+f-1)/2),this}setFromMatrixPosition(e){let a=e.elements;return this.x=a[12],this.y=a[13],this.z=a[14],this.w=a[15],this}min(e){return this.x=Math.min(this.x,e.x),this.y=Math.min(this.y,e.y),this.z=Math.min(this.z,e.z),this.w=Math.min(this.w,e.w),this}max(e){return this.x=Math.max(this.x,e.x),this.y=Math.max(this.y,e.y),this.z=Math.max(this.z,e.z),this.w=Math.max(this.w,e.w),this}clamp(e,a){return this.x=Xe(this.x,e.x,a.x),this.y=Xe(this.y,e.y,a.y),this.z=Xe(this.z,e.z,a.z),this.w=Xe(this.w,e.w,a.w),this}clampScalar(e,a){return this.x=Xe(this.x,e,a),this.y=Xe(this.y,e,a),this.z=Xe(this.z,e,a),this.w=Xe(this.w,e,a),this}clampLength(e,a){let n=this.length();return this.divideScalar(n||1).multiplyScalar(Xe(n,e,a))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this.z=Math.floor(this.z),this.w=Math.floor(this.w),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this.z=Math.ceil(this.z),this.w=Math.ceil(this.w),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this.z=Math.round(this.z),this.w=Math.round(this.w),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this.z=Math.trunc(this.z),this.w=Math.trunc(this.w),this}negate(){return this.x=-this.x,this.y=-this.y,this.z=-this.z,this.w=-this.w,this}dot(e){return this.x*e.x+this.y*e.y+this.z*e.z+this.w*e.w}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w}length(){return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)+Math.abs(this.z)+Math.abs(this.w)}normalize(){return this.divideScalar(this.length()||1)}setLength(e){return this.normalize().multiplyScalar(e)}lerp(e,a){return this.x+=(e.x-this.x)*a,this.y+=(e.y-this.y)*a,this.z+=(e.z-this.z)*a,this.w+=(e.w-this.w)*a,this}lerpVectors(e,a,n){return this.x=e.x+(a.x-e.x)*n,this.y=e.y+(a.y-e.y)*n,this.z=e.z+(a.z-e.z)*n,this.w=e.w+(a.w-e.w)*n,this}equals(e){return e.x===this.x&&e.y===this.y&&e.z===this.z&&e.w===this.w}fromArray(e,a=0){return this.x=e[a],this.y=e[a+1],this.z=e[a+2],this.w=e[a+3],this}toArray(e=[],a=0){return e[a]=this.x,e[a+1]=this.y,e[a+2]=this.z,e[a+3]=this.w,e}fromBufferAttribute(e,a){return this.x=e.getX(a),this.y=e.getY(a),this.z=e.getZ(a),this.w=e.getW(a),this}random(){return this.x=Math.random(),this.y=Math.random(),this.z=Math.random(),this.w=Math.random(),this}*[Symbol.iterator](){yield this.x,yield this.y,yield this.z,yield this.w}},Ju=class extends Pn{constructor(e=1,a=1,n={}){super(),n=Object.assign({generateMipmaps:!1,internalFormat:null,minFilter:ia,depthBuffer:!0,stencilBuffer:!1,resolveDepthBuffer:!0,resolveStencilBuffer:!0,depthTexture:null,samples:0,count:1,depth:1,multiview:!1,useArrayDepthTexture:!1},n),this.isRenderTarget=!0,this.width=e,this.height=a,this.depth=n.depth,this.scissor=new At(0,0,e,a),this.scissorTest=!1,this.viewport=new At(0,0,e,a),this.textures=[];let i={width:e,height:a,depth:n.depth},s=new Ca(i),r=n.count;for(let o=0;o<r;o++)this.textures[o]=s.clone(),this.textures[o].isRenderTargetTexture=!0,this.textures[o].renderTarget=this;this._setTextureOptions(n),this.depthBuffer=n.depthBuffer,this.stencilBuffer=n.stencilBuffer,this.resolveDepthBuffer=n.resolveDepthBuffer,this.resolveStencilBuffer=n.resolveStencilBuffer,this._depthTexture=null,this.depthTexture=n.depthTexture,this.samples=n.samples,this.multiview=n.multiview,this.useArrayDepthTexture=n.useArrayDepthTexture}_setTextureOptions(e={}){let a={minFilter:ia,generateMipmaps:!1,flipY:!1,internalFormat:null};e.mapping!==void 0&&(a.mapping=e.mapping),e.wrapS!==void 0&&(a.wrapS=e.wrapS),e.wrapT!==void 0&&(a.wrapT=e.wrapT),e.wrapR!==void 0&&(a.wrapR=e.wrapR),e.magFilter!==void 0&&(a.magFilter=e.magFilter),e.minFilter!==void 0&&(a.minFilter=e.minFilter),e.format!==void 0&&(a.format=e.format),e.type!==void 0&&(a.type=e.type),e.anisotropy!==void 0&&(a.anisotropy=e.anisotropy),e.colorSpace!==void 0&&(a.colorSpace=e.colorSpace),e.flipY!==void 0&&(a.flipY=e.flipY),e.generateMipmaps!==void 0&&(a.generateMipmaps=e.generateMipmaps),e.internalFormat!==void 0&&(a.internalFormat=e.internalFormat);for(let n=0;n<this.textures.length;n++)this.textures[n].setValues(a)}get texture(){return this.textures[0]}set texture(e){this.textures[0]=e}set depthTexture(e){this._depthTexture!==null&&(this._depthTexture.renderTarget=null),e!==null&&(e.renderTarget=this),this._depthTexture=e}get depthTexture(){return this._depthTexture}setSize(e,a,n=1){if(this.width!==e||this.height!==a||this.depth!==n){this.width=e,this.height=a,this.depth=n;for(let i=0,s=this.textures.length;i<s;i++)this.textures[i].image.width=e,this.textures[i].image.height=a,this.textures[i].image.depth=n,this.textures[i].isData3DTexture!==!0&&(this.textures[i].isArrayTexture=this.textures[i].image.depth>1);this.dispose()}this.viewport.set(0,0,e,a),this.scissor.set(0,0,e,a)}clone(){return new this.constructor().copy(this)}copy(e){this.width=e.width,this.height=e.height,this.depth=e.depth,this.scissor.copy(e.scissor),this.scissorTest=e.scissorTest,this.viewport.copy(e.viewport),this.textures.length=0;for(let a=0,n=e.textures.length;a<n;a++){this.textures[a]=e.textures[a].clone(),this.textures[a].isRenderTargetTexture=!0,this.textures[a].renderTarget=this;let i=Object.assign({},e.textures[a].image);this.textures[a].source=new Mr(i)}return this.depthBuffer=e.depthBuffer,this.stencilBuffer=e.stencilBuffer,this.resolveDepthBuffer=e.resolveDepthBuffer,this.resolveStencilBuffer=e.resolveStencilBuffer,e.depthTexture!==null&&(this.depthTexture=e.depthTexture.clone()),this.samples=e.samples,this.multiview=e.multiview,this.useArrayDepthTexture=e.useArrayDepthTexture,this}dispose(){this.dispatchEvent({type:"dispose"})}},Fa=class extends Ju{constructor(e=1,a=1,n={}){super(e,a,n),this.isWebGLRenderTarget=!0}},Oo=class extends Ca{constructor(e=null,a=1,n=1,i=1){super(null),this.isDataArrayTexture=!0,this.image={data:e,width:a,height:n,depth:i},this.magFilter=$t,this.minFilter=$t,this.wrapR=Rn,this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1,this.layerUpdates=new Set}addLayerUpdate(e){this.layerUpdates.add(e)}clearLayerUpdates(){this.layerUpdates.clear()}};var Qu=class extends Ca{constructor(e=null,a=1,n=1,i=1){super(null),this.isData3DTexture=!0,this.image={data:e,width:a,height:n,depth:i},this.magFilter=$t,this.minFilter=$t,this.wrapR=Rn,this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}};var Ot=class t{static{t.prototype.isMatrix4=!0}constructor(e,a,n,i,s,r,o,l,u,d,p,c,h,v,b,m){this.elements=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],e!==void 0&&this.set(e,a,n,i,s,r,o,l,u,d,p,c,h,v,b,m)}set(e,a,n,i,s,r,o,l,u,d,p,c,h,v,b,m){let f=this.elements;return f[0]=e,f[4]=a,f[8]=n,f[12]=i,f[1]=s,f[5]=r,f[9]=o,f[13]=l,f[2]=u,f[6]=d,f[10]=p,f[14]=c,f[3]=h,f[7]=v,f[11]=b,f[15]=m,this}identity(){return this.set(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1),this}clone(){return new t().fromArray(this.elements)}copy(e){let a=this.elements,n=e.elements;return a[0]=n[0],a[1]=n[1],a[2]=n[2],a[3]=n[3],a[4]=n[4],a[5]=n[5],a[6]=n[6],a[7]=n[7],a[8]=n[8],a[9]=n[9],a[10]=n[10],a[11]=n[11],a[12]=n[12],a[13]=n[13],a[14]=n[14],a[15]=n[15],this}copyPosition(e){let a=this.elements,n=e.elements;return a[12]=n[12],a[13]=n[13],a[14]=n[14],this}setFromMatrix3(e){let a=e.elements;return this.set(a[0],a[3],a[6],0,a[1],a[4],a[7],0,a[2],a[5],a[8],0,0,0,0,1),this}extractBasis(e,a,n){return this.determinantAffine()===0?(e.set(1,0,0),a.set(0,1,0),n.set(0,0,1),this):(e.setFromMatrixColumn(this,0),a.setFromMatrixColumn(this,1),n.setFromMatrixColumn(this,2),this)}makeBasis(e,a,n){return this.set(e.x,a.x,n.x,0,e.y,a.y,n.y,0,e.z,a.z,n.z,0,0,0,0,1),this}extractRotation(e){if(e.determinantAffine()===0)return this.identity();let a=this.elements,n=e.elements,i=1/ur.setFromMatrixColumn(e,0).length(),s=1/ur.setFromMatrixColumn(e,1).length(),r=1/ur.setFromMatrixColumn(e,2).length();return a[0]=n[0]*i,a[1]=n[1]*i,a[2]=n[2]*i,a[3]=0,a[4]=n[4]*s,a[5]=n[5]*s,a[6]=n[6]*s,a[7]=0,a[8]=n[8]*r,a[9]=n[9]*r,a[10]=n[10]*r,a[11]=0,a[12]=0,a[13]=0,a[14]=0,a[15]=1,this}makeRotationFromEuler(e){let a=this.elements,n=e.x,i=e.y,s=e.z,r=Math.cos(n),o=Math.sin(n),l=Math.cos(i),u=Math.sin(i),d=Math.cos(s),p=Math.sin(s);if(e.order==="XYZ"){let c=r*d,h=r*p,v=o*d,b=o*p;a[0]=l*d,a[4]=-l*p,a[8]=u,a[1]=h+v*u,a[5]=c-b*u,a[9]=-o*l,a[2]=b-c*u,a[6]=v+h*u,a[10]=r*l}else if(e.order==="YXZ"){let c=l*d,h=l*p,v=u*d,b=u*p;a[0]=c+b*o,a[4]=v*o-h,a[8]=r*u,a[1]=r*p,a[5]=r*d,a[9]=-o,a[2]=h*o-v,a[6]=b+c*o,a[10]=r*l}else if(e.order==="ZXY"){let c=l*d,h=l*p,v=u*d,b=u*p;a[0]=c-b*o,a[4]=-r*p,a[8]=v+h*o,a[1]=h+v*o,a[5]=r*d,a[9]=b-c*o,a[2]=-r*u,a[6]=o,a[10]=r*l}else if(e.order==="ZYX"){let c=r*d,h=r*p,v=o*d,b=o*p;a[0]=l*d,a[4]=v*u-h,a[8]=c*u+b,a[1]=l*p,a[5]=b*u+c,a[9]=h*u-v,a[2]=-u,a[6]=o*l,a[10]=r*l}else if(e.order==="YZX"){let c=r*l,h=r*u,v=o*l,b=o*u;a[0]=l*d,a[4]=b-c*p,a[8]=v*p+h,a[1]=p,a[5]=r*d,a[9]=-o*d,a[2]=-u*d,a[6]=h*p+v,a[10]=c-b*p}else if(e.order==="XZY"){let c=r*l,h=r*u,v=o*l,b=o*u;a[0]=l*d,a[4]=-p,a[8]=u*d,a[1]=c*p+b,a[5]=r*d,a[9]=h*p-v,a[2]=v*p-h,a[6]=o*d,a[10]=b*p+c}return a[3]=0,a[7]=0,a[11]=0,a[12]=0,a[13]=0,a[14]=0,a[15]=1,this}makeRotationFromQuaternion(e){return this.compose(Pb,e,Ub)}lookAt(e,a,n){let i=this.elements;return Ba.subVectors(e,a),Ba.lengthSq()===0&&(Ba.z=1),Ba.normalize(),wi.crossVectors(n,Ba),wi.lengthSq()===0&&(Math.abs(n.z)===1?Ba.x+=1e-4:Ba.z+=1e-4,Ba.normalize(),wi.crossVectors(n,Ba)),wi.normalize(),mu.crossVectors(Ba,wi),i[0]=wi.x,i[4]=mu.x,i[8]=Ba.x,i[1]=wi.y,i[5]=mu.y,i[9]=Ba.y,i[2]=wi.z,i[6]=mu.z,i[10]=Ba.z,this}multiply(e){return this.multiplyMatrices(this,e)}premultiply(e){return this.multiplyMatrices(e,this)}multiplyMatrices(e,a){let n=e.elements,i=a.elements,s=this.elements,r=n[0],o=n[4],l=n[8],u=n[12],d=n[1],p=n[5],c=n[9],h=n[13],v=n[2],b=n[6],m=n[10],f=n[14],x=n[3],S=n[7],_=n[11],L=n[15],C=i[0],T=i[4],y=i[8],A=i[12],E=i[1],w=i[5],B=i[9],X=i[13],K=i[2],z=i[6],W=i[10],V=i[14],j=i[3],ee=i[7],fe=i[11],me=i[15];return s[0]=r*C+o*E+l*K+u*j,s[4]=r*T+o*w+l*z+u*ee,s[8]=r*y+o*B+l*W+u*fe,s[12]=r*A+o*X+l*V+u*me,s[1]=d*C+p*E+c*K+h*j,s[5]=d*T+p*w+c*z+h*ee,s[9]=d*y+p*B+c*W+h*fe,s[13]=d*A+p*X+c*V+h*me,s[2]=v*C+b*E+m*K+f*j,s[6]=v*T+b*w+m*z+f*ee,s[10]=v*y+b*B+m*W+f*fe,s[14]=v*A+b*X+m*V+f*me,s[3]=x*C+S*E+_*K+L*j,s[7]=x*T+S*w+_*z+L*ee,s[11]=x*y+S*B+_*W+L*fe,s[15]=x*A+S*X+_*V+L*me,this}multiplyScalar(e){let a=this.elements;return a[0]*=e,a[4]*=e,a[8]*=e,a[12]*=e,a[1]*=e,a[5]*=e,a[9]*=e,a[13]*=e,a[2]*=e,a[6]*=e,a[10]*=e,a[14]*=e,a[3]*=e,a[7]*=e,a[11]*=e,a[15]*=e,this}determinant(){let e=this.elements,a=e[0],n=e[4],i=e[8],s=e[12],r=e[1],o=e[5],l=e[9],u=e[13],d=e[2],p=e[6],c=e[10],h=e[14],v=e[3],b=e[7],m=e[11],f=e[15],x=l*h-u*c,S=o*h-u*p,_=o*c-l*p,L=r*h-u*d,C=r*c-l*d,T=r*p-o*d;return a*(b*x-m*S+f*_)-n*(v*x-m*L+f*C)+i*(v*S-b*L+f*T)-s*(v*_-b*C+m*T)}determinantAffine(){let e=this.elements,a=e[0],n=e[4],i=e[8],s=e[1],r=e[5],o=e[9],l=e[2],u=e[6],d=e[10];return a*(r*d-o*u)-n*(s*d-o*l)+i*(s*u-r*l)}transpose(){let e=this.elements,a;return a=e[1],e[1]=e[4],e[4]=a,a=e[2],e[2]=e[8],e[8]=a,a=e[6],e[6]=e[9],e[9]=a,a=e[3],e[3]=e[12],e[12]=a,a=e[7],e[7]=e[13],e[13]=a,a=e[11],e[11]=e[14],e[14]=a,this}setPosition(e,a,n){let i=this.elements;return e.isVector3?(i[12]=e.x,i[13]=e.y,i[14]=e.z):(i[12]=e,i[13]=a,i[14]=n),this}invert(){let e=this.elements,a=e[0],n=e[1],i=e[2],s=e[3],r=e[4],o=e[5],l=e[6],u=e[7],d=e[8],p=e[9],c=e[10],h=e[11],v=e[12],b=e[13],m=e[14],f=e[15],x=a*o-n*r,S=a*l-i*r,_=a*u-s*r,L=n*l-i*o,C=n*u-s*o,T=i*u-s*l,y=d*b-p*v,A=d*m-c*v,E=d*f-h*v,w=p*m-c*b,B=p*f-h*b,X=c*f-h*m,K=x*X-S*B+_*w+L*E-C*A+T*y;if(K===0)return this.set(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);let z=1/K;return e[0]=(o*X-l*B+u*w)*z,e[1]=(i*B-n*X-s*w)*z,e[2]=(b*T-m*C+f*L)*z,e[3]=(c*C-p*T-h*L)*z,e[4]=(l*E-r*X-u*A)*z,e[5]=(a*X-i*E+s*A)*z,e[6]=(m*_-v*T-f*S)*z,e[7]=(d*T-c*_+h*S)*z,e[8]=(r*B-o*E+u*y)*z,e[9]=(n*E-a*B-s*y)*z,e[10]=(v*C-b*_+f*x)*z,e[11]=(p*_-d*C-h*x)*z,e[12]=(o*A-r*w-l*y)*z,e[13]=(a*w-n*A+i*y)*z,e[14]=(b*S-v*L-m*x)*z,e[15]=(d*L-p*S+c*x)*z,this}scale(e){let a=this.elements,n=e.x,i=e.y,s=e.z;return a[0]*=n,a[4]*=i,a[8]*=s,a[1]*=n,a[5]*=i,a[9]*=s,a[2]*=n,a[6]*=i,a[10]*=s,a[3]*=n,a[7]*=i,a[11]*=s,this}getMaxScaleOnAxis(){let e=this.elements,a=e[0]*e[0]+e[1]*e[1]+e[2]*e[2],n=e[4]*e[4]+e[5]*e[5]+e[6]*e[6],i=e[8]*e[8]+e[9]*e[9]+e[10]*e[10];return Math.sqrt(Math.max(a,n,i))}makeTranslation(e,a,n){return e.isVector3?this.set(1,0,0,e.x,0,1,0,e.y,0,0,1,e.z,0,0,0,1):this.set(1,0,0,e,0,1,0,a,0,0,1,n,0,0,0,1),this}makeRotationX(e){let a=Math.cos(e),n=Math.sin(e);return this.set(1,0,0,0,0,a,-n,0,0,n,a,0,0,0,0,1),this}makeRotationY(e){let a=Math.cos(e),n=Math.sin(e);return this.set(a,0,n,0,0,1,0,0,-n,0,a,0,0,0,0,1),this}makeRotationZ(e){let a=Math.cos(e),n=Math.sin(e);return this.set(a,-n,0,0,n,a,0,0,0,0,1,0,0,0,0,1),this}makeRotationAxis(e,a){let n=Math.cos(a),i=Math.sin(a),s=1-n,r=e.x,o=e.y,l=e.z,u=s*r,d=s*o;return this.set(u*r+n,u*o-i*l,u*l+i*o,0,u*o+i*l,d*o+n,d*l-i*r,0,u*l-i*o,d*l+i*r,s*l*l+n,0,0,0,0,1),this}makeScale(e,a,n){return this.set(e,0,0,0,0,a,0,0,0,0,n,0,0,0,0,1),this}makeShear(e,a,n,i,s,r){return this.set(1,n,s,0,e,1,r,0,a,i,1,0,0,0,0,1),this}compose(e,a,n){let i=this.elements,s=a._x,r=a._y,o=a._z,l=a._w,u=s+s,d=r+r,p=o+o,c=s*u,h=s*d,v=s*p,b=r*d,m=r*p,f=o*p,x=l*u,S=l*d,_=l*p,L=n.x,C=n.y,T=n.z;return i[0]=(1-(b+f))*L,i[1]=(h+_)*L,i[2]=(v-S)*L,i[3]=0,i[4]=(h-_)*C,i[5]=(1-(c+f))*C,i[6]=(m+x)*C,i[7]=0,i[8]=(v+S)*T,i[9]=(m-x)*T,i[10]=(1-(c+b))*T,i[11]=0,i[12]=e.x,i[13]=e.y,i[14]=e.z,i[15]=1,this}decompose(e,a,n){let i=this.elements;e.x=i[12],e.y=i[13],e.z=i[14];let s=this.determinantAffine();if(s===0)return n.set(1,1,1),a.identity(),this;let r=ur.set(i[0],i[1],i[2]).length(),o=ur.set(i[4],i[5],i[6]).length(),l=ur.set(i[8],i[9],i[10]).length();s<0&&(r=-r),pn.copy(this);let u=1/r,d=1/o,p=1/l;return pn.elements[0]*=u,pn.elements[1]*=u,pn.elements[2]*=u,pn.elements[4]*=d,pn.elements[5]*=d,pn.elements[6]*=d,pn.elements[8]*=p,pn.elements[9]*=p,pn.elements[10]*=p,a.setFromRotationMatrix(pn),n.x=r,n.y=o,n.z=l,this}makePerspective(e,a,n,i,s,r,o=xn,l=!1){let u=this.elements,d=2*s/(a-e),p=2*s/(n-i),c=(a+e)/(a-e),h=(n+i)/(n-i),v,b;if(l)v=s/(r-s),b=r*s/(r-s);else if(o===xn)v=-(r+s)/(r-s),b=-2*r*s/(r-s);else if(o===Uo)v=-r/(r-s),b=-r*s/(r-s);else throw new Error("THREE.Matrix4.makePerspective(): Invalid coordinate system: "+o);return u[0]=d,u[4]=0,u[8]=c,u[12]=0,u[1]=0,u[5]=p,u[9]=h,u[13]=0,u[2]=0,u[6]=0,u[10]=v,u[14]=b,u[3]=0,u[7]=0,u[11]=-1,u[15]=0,this}makeOrthographic(e,a,n,i,s,r,o=xn,l=!1){let u=this.elements,d=2/(a-e),p=2/(n-i),c=-(a+e)/(a-e),h=-(n+i)/(n-i),v,b;if(l)v=1/(r-s),b=r/(r-s);else if(o===xn)v=-2/(r-s),b=-(r+s)/(r-s);else if(o===Uo)v=-1/(r-s),b=-s/(r-s);else throw new Error("THREE.Matrix4.makeOrthographic(): Invalid coordinate system: "+o);return u[0]=d,u[4]=0,u[8]=0,u[12]=c,u[1]=0,u[5]=p,u[9]=0,u[13]=h,u[2]=0,u[6]=0,u[10]=v,u[14]=b,u[3]=0,u[7]=0,u[11]=0,u[15]=1,this}equals(e){let a=this.elements,n=e.elements;for(let i=0;i<16;i++)if(a[i]!==n[i])return!1;return!0}fromArray(e,a=0){for(let n=0;n<16;n++)this.elements[n]=e[n+a];return this}toArray(e=[],a=0){let n=this.elements;return e[a]=n[0],e[a+1]=n[1],e[a+2]=n[2],e[a+3]=n[3],e[a+4]=n[4],e[a+5]=n[5],e[a+6]=n[6],e[a+7]=n[7],e[a+8]=n[8],e[a+9]=n[9],e[a+10]=n[10],e[a+11]=n[11],e[a+12]=n[12],e[a+13]=n[13],e[a+14]=n[14],e[a+15]=n[15],e}},ur=new F,pn=new Ot,Pb=new F(0,0,0),Ub=new F(1,1,1),wi=new F,mu=new F,Ba=new F,wx=new Ot,Rx=new Un,Fi=class t{constructor(e=0,a=0,n=0,i=t.DEFAULT_ORDER){this.isEuler=!0,this._x=e,this._y=a,this._z=n,this._order=i}get x(){return this._x}set x(e){this._x=e,this._onChangeCallback()}get y(){return this._y}set y(e){this._y=e,this._onChangeCallback()}get z(){return this._z}set z(e){this._z=e,this._onChangeCallback()}get order(){return this._order}set order(e){this._order=e,this._onChangeCallback()}set(e,a,n,i=this._order){return this._x=e,this._y=a,this._z=n,this._order=i,this._onChangeCallback(),this}clone(){return new this.constructor(this._x,this._y,this._z,this._order)}copy(e){return this._x=e._x,this._y=e._y,this._z=e._z,this._order=e._order,this._onChangeCallback(),this}setFromRotationMatrix(e,a=this._order,n=!0){let i=e.elements,s=i[0],r=i[4],o=i[8],l=i[1],u=i[5],d=i[9],p=i[2],c=i[6],h=i[10];switch(a){case"XYZ":this._y=Math.asin(Xe(o,-1,1)),Math.abs(o)<.9999999?(this._x=Math.atan2(-d,h),this._z=Math.atan2(-r,s)):(this._x=Math.atan2(c,u),this._z=0);break;case"YXZ":this._x=Math.asin(-Xe(d,-1,1)),Math.abs(d)<.9999999?(this._y=Math.atan2(o,h),this._z=Math.atan2(l,u)):(this._y=Math.atan2(-p,s),this._z=0);break;case"ZXY":this._x=Math.asin(Xe(c,-1,1)),Math.abs(c)<.9999999?(this._y=Math.atan2(-p,h),this._z=Math.atan2(-r,u)):(this._y=0,this._z=Math.atan2(l,s));break;case"ZYX":this._y=Math.asin(-Xe(p,-1,1)),Math.abs(p)<.9999999?(this._x=Math.atan2(c,h),this._z=Math.atan2(l,s)):(this._x=0,this._z=Math.atan2(-r,u));break;case"YZX":this._z=Math.asin(Xe(l,-1,1)),Math.abs(l)<.9999999?(this._x=Math.atan2(-d,u),this._y=Math.atan2(-p,s)):(this._x=0,this._y=Math.atan2(o,h));break;case"XZY":this._z=Math.asin(-Xe(r,-1,1)),Math.abs(r)<.9999999?(this._x=Math.atan2(c,u),this._y=Math.atan2(o,s)):(this._x=Math.atan2(-d,h),this._y=0);break;default:Ae("Euler: .setFromRotationMatrix() encountered an unknown order: "+a)}return this._order=a,n===!0&&this._onChangeCallback(),this}setFromQuaternion(e,a,n){return wx.makeRotationFromQuaternion(e),this.setFromRotationMatrix(wx,a,n)}setFromVector3(e,a=this._order){return this.set(e.x,e.y,e.z,a)}reorder(e){return Rx.setFromEuler(this),this.setFromQuaternion(Rx,e)}equals(e){return e._x===this._x&&e._y===this._y&&e._z===this._z&&e._order===this._order}fromArray(e){return this._x=e[0],this._y=e[1],this._z=e[2],e[3]!==void 0&&(this._order=e[3]),this._onChangeCallback(),this}toArray(e=[],a=0){return e[a]=this._x,e[a+1]=this._y,e[a+2]=this._z,e[a+3]=this._order,e}_onChange(e){return this._onChangeCallback=e,this}_onChangeCallback(){}*[Symbol.iterator](){yield this._x,yield this._y,yield this._z,yield this._order}};Fi.DEFAULT_ORDER="XYZ";var No=class{constructor(){this.mask=1}set(e){this.mask=(1<<e|0)>>>0}enable(e){this.mask|=1<<e|0}enableAll(){this.mask=-1}toggle(e){this.mask^=1<<e|0}disable(e){this.mask&=~(1<<e|0)}disableAll(){this.mask=0}test(e){return(this.mask&e.mask)!==0}isEnabled(e){return(this.mask&(1<<e|0))!==0}},Bb=0,Dx=new F,cr=new Un,Jn=new Ot,gu=new F,To=new F,Ob=new F,Nb=new Un,Px=new F(1,0,0),Ux=new F(0,1,0),Bx=new F(0,0,1),Ox={type:"added"},Fb={type:"removed"},fr={type:"childadded",child:null},rh={type:"childremoved",child:null},en=class t extends Pn{constructor(){super(),this.isObject3D=!0,Object.defineProperty(this,"id",{value:Bb++}),this.uuid=il(),this.name="",this.type="Object3D",this.parent=null,this.children=[],this.up=t.DEFAULT_UP.clone();let e=new F,a=new Fi,n=new Un,i=new F(1,1,1);function s(){n.setFromEuler(a,!1)}function r(){a.setFromQuaternion(n,void 0,!1)}a._onChange(s),n._onChange(r),Object.defineProperties(this,{position:{configurable:!0,enumerable:!0,value:e},rotation:{configurable:!0,enumerable:!0,value:a},quaternion:{configurable:!0,enumerable:!0,value:n},scale:{configurable:!0,enumerable:!0,value:i},modelViewMatrix:{value:new Ot},normalMatrix:{value:new De}}),this.matrix=new Ot,this.matrixWorld=new Ot,this.matrixAutoUpdate=t.DEFAULT_MATRIX_AUTO_UPDATE,this.matrixWorldAutoUpdate=t.DEFAULT_MATRIX_WORLD_AUTO_UPDATE,this.matrixWorldNeedsUpdate=!1,this.layers=new No,this.visible=!0,this.castShadow=!1,this.receiveShadow=!1,this.frustumCulled=!0,this.renderOrder=0,this.animations=[],this.customDepthMaterial=void 0,this.customDistanceMaterial=void 0,this.static=!1,this.userData={},this.pivot=null}onBeforeShadow(){}onAfterShadow(){}onBeforeRender(){}onAfterRender(){}applyMatrix4(e){this.matrixAutoUpdate&&this.updateMatrix(),this.matrix.premultiply(e),this.matrix.decompose(this.position,this.quaternion,this.scale)}applyQuaternion(e){return this.quaternion.premultiply(e),this}setRotationFromAxisAngle(e,a){this.quaternion.setFromAxisAngle(e,a)}setRotationFromEuler(e){this.quaternion.setFromEuler(e,!0)}setRotationFromMatrix(e){this.quaternion.setFromRotationMatrix(e)}setRotationFromQuaternion(e){this.quaternion.copy(e)}rotateOnAxis(e,a){return cr.setFromAxisAngle(e,a),this.quaternion.multiply(cr),this}rotateOnWorldAxis(e,a){return cr.setFromAxisAngle(e,a),this.quaternion.premultiply(cr),this}rotateX(e){return this.rotateOnAxis(Px,e)}rotateY(e){return this.rotateOnAxis(Ux,e)}rotateZ(e){return this.rotateOnAxis(Bx,e)}translateOnAxis(e,a){return Dx.copy(e).applyQuaternion(this.quaternion),this.position.add(Dx.multiplyScalar(a)),this}translateX(e){return this.translateOnAxis(Px,e)}translateY(e){return this.translateOnAxis(Ux,e)}translateZ(e){return this.translateOnAxis(Bx,e)}localToWorld(e){return this.updateWorldMatrix(!0,!1),e.applyMatrix4(this.matrixWorld)}worldToLocal(e){return this.updateWorldMatrix(!0,!1),e.applyMatrix4(Jn.copy(this.matrixWorld).invert())}lookAt(e,a,n){e.isVector3?gu.copy(e):gu.set(e,a,n);let i=this.parent;this.updateWorldMatrix(!0,!1),To.setFromMatrixPosition(this.matrixWorld),this.isCamera||this.isLight?Jn.lookAt(To,gu,this.up):Jn.lookAt(gu,To,this.up),this.quaternion.setFromRotationMatrix(Jn),i&&(Jn.extractRotation(i.matrixWorld),cr.setFromRotationMatrix(Jn),this.quaternion.premultiply(cr.invert()))}add(e){if(arguments.length>1){for(let a=0;a<arguments.length;a++)this.add(arguments[a]);return this}return e===this?(Ee("Object3D.add: object can't be added as a child of itself.",e),this):(e&&e.isObject3D?(e.removeFromParent(),e.parent=this,this.children.push(e),e.dispatchEvent(Ox),fr.child=e,this.dispatchEvent(fr),fr.child=null):Ee("Object3D.add: object not an instance of THREE.Object3D.",e),this)}remove(e){if(arguments.length>1){for(let n=0;n<arguments.length;n++)this.remove(arguments[n]);return this}let a=this.children.indexOf(e);return a!==-1&&(e.parent=null,this.children.splice(a,1),e.dispatchEvent(Fb),rh.child=e,this.dispatchEvent(rh),rh.child=null),this}removeFromParent(){let e=this.parent;return e!==null&&e.remove(this),this}clear(){return this.remove(...this.children)}attach(e){return this.updateWorldMatrix(!0,!1),Jn.copy(this.matrixWorld).invert(),e.parent!==null&&(e.parent.updateWorldMatrix(!0,!1),Jn.multiply(e.parent.matrixWorld)),e.applyMatrix4(Jn),e.removeFromParent(),e.parent=this,this.children.push(e),e.updateWorldMatrix(!1,!0),e.dispatchEvent(Ox),fr.child=e,this.dispatchEvent(fr),fr.child=null,this}getObjectById(e){return this.getObjectByProperty("id",e)}getObjectByName(e){return this.getObjectByProperty("name",e)}getObjectByProperty(e,a){if(this[e]===a)return this;for(let n=0,i=this.children.length;n<i;n++){let r=this.children[n].getObjectByProperty(e,a);if(r!==void 0)return r}}getObjectsByProperty(e,a,n=[]){this[e]===a&&n.push(this);let i=this.children;for(let s=0,r=i.length;s<r;s++)i[s].getObjectsByProperty(e,a,n);return n}getWorldPosition(e){return this.updateWorldMatrix(!0,!1),e.setFromMatrixPosition(this.matrixWorld)}getWorldQuaternion(e){return this.updateWorldMatrix(!0,!1),this.matrixWorld.decompose(To,e,Ob),e}getWorldScale(e){return this.updateWorldMatrix(!0,!1),this.matrixWorld.decompose(To,Nb,e),e}getWorldDirection(e){this.updateWorldMatrix(!0,!1);let a=this.matrixWorld.elements;return e.set(a[8],a[9],a[10]).normalize()}raycast(){}traverse(e){e(this);let a=this.children;for(let n=0,i=a.length;n<i;n++)a[n].traverse(e)}traverseVisible(e){if(this.visible===!1)return;e(this);let a=this.children;for(let n=0,i=a.length;n<i;n++)a[n].traverseVisible(e)}traverseAncestors(e){let a=this.parent;a!==null&&(e(a),a.traverseAncestors(e))}updateMatrix(){this.matrix.compose(this.position,this.quaternion,this.scale);let e=this.pivot;if(e!==null){let a=e.x,n=e.y,i=e.z,s=this.matrix.elements;s[12]+=a-s[0]*a-s[4]*n-s[8]*i,s[13]+=n-s[1]*a-s[5]*n-s[9]*i,s[14]+=i-s[2]*a-s[6]*n-s[10]*i}this.matrixWorldNeedsUpdate=!0}updateMatrixWorld(e){this.matrixAutoUpdate&&this.updateMatrix(),(this.matrixWorldNeedsUpdate||e)&&(this.matrixWorldAutoUpdate===!0&&(this.parent===null?this.matrixWorld.copy(this.matrix):this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix)),this.matrixWorldNeedsUpdate=!1,e=!0);let a=this.children;for(let n=0,i=a.length;n<i;n++)a[n].updateMatrixWorld(e)}updateWorldMatrix(e,a,n=!1){let i=this.parent;if(e===!0&&i!==null&&i.updateWorldMatrix(!0,!1),this.matrixAutoUpdate&&this.updateMatrix(),(this.matrixWorldNeedsUpdate||n)&&(this.matrixWorldAutoUpdate===!0&&(this.parent===null?this.matrixWorld.copy(this.matrix):this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix)),this.matrixWorldNeedsUpdate=!1,n=!0),a===!0){let s=this.children;for(let r=0,o=s.length;r<o;r++)s[r].updateWorldMatrix(!1,!0,n)}}toJSON(e){let a=e===void 0||typeof e=="string",n={};a&&(e={geometries:{},materials:{},textures:{},images:{},shapes:{},skeletons:{},animations:{},nodes:{}},n.metadata={version:4.7,type:"Object",generator:"Object3D.toJSON"});let i={};i.uuid=this.uuid,i.type=this.type,this.name!==""&&(i.name=this.name),this.castShadow===!0&&(i.castShadow=!0),this.receiveShadow===!0&&(i.receiveShadow=!0),this.visible===!1&&(i.visible=!1),this.frustumCulled===!1&&(i.frustumCulled=!1),this.renderOrder!==0&&(i.renderOrder=this.renderOrder),this.static!==!1&&(i.static=this.static),Object.keys(this.userData).length>0&&(i.userData=this.userData),i.layers=this.layers.mask,i.matrix=this.matrix.toArray(),i.up=this.up.toArray(),this.pivot!==null&&(i.pivot=this.pivot.toArray()),this.matrixAutoUpdate===!1&&(i.matrixAutoUpdate=!1),this.morphTargetDictionary!==void 0&&(i.morphTargetDictionary=Object.assign({},this.morphTargetDictionary)),this.morphTargetInfluences!==void 0&&(i.morphTargetInfluences=this.morphTargetInfluences.slice()),this.isInstancedMesh&&(i.type="InstancedMesh",i.count=this.count,i.instanceMatrix=this.instanceMatrix.toJSON(),this.instanceColor!==null&&(i.instanceColor=this.instanceColor.toJSON())),this.isBatchedMesh&&(i.type="BatchedMesh",i.perObjectFrustumCulled=this.perObjectFrustumCulled,i.sortObjects=this.sortObjects,i.drawRanges=this._drawRanges,i.reservedRanges=this._reservedRanges,i.geometryInfo=this._geometryInfo.map(o=>({...o,boundingBox:o.boundingBox?o.boundingBox.toJSON():void 0,boundingSphere:o.boundingSphere?o.boundingSphere.toJSON():void 0})),i.instanceInfo=this._instanceInfo.map(o=>({...o})),i.availableInstanceIds=this._availableInstanceIds.slice(),i.availableGeometryIds=this._availableGeometryIds.slice(),i.nextIndexStart=this._nextIndexStart,i.nextVertexStart=this._nextVertexStart,i.geometryCount=this._geometryCount,i.maxInstanceCount=this._maxInstanceCount,i.maxVertexCount=this._maxVertexCount,i.maxIndexCount=this._maxIndexCount,i.geometryInitialized=this._geometryInitialized,i.matricesTexture=this._matricesTexture.toJSON(e),i.indirectTexture=this._indirectTexture.toJSON(e),this._colorsTexture!==null&&(i.colorsTexture=this._colorsTexture.toJSON(e)),this.boundingSphere!==null&&(i.boundingSphere=this.boundingSphere.toJSON()),this.boundingBox!==null&&(i.boundingBox=this.boundingBox.toJSON()));function s(o,l){return o[l.uuid]===void 0&&(o[l.uuid]=l.toJSON(e)),l.uuid}if(this.isScene)this.background&&(this.background.isColor?i.background=this.background.toJSON():this.background.isTexture&&(i.background=this.background.toJSON(e).uuid)),this.environment&&this.environment.isTexture&&this.environment.isRenderTargetTexture!==!0&&(i.environment=this.environment.toJSON(e).uuid);else if(this.isMesh||this.isLine||this.isPoints){i.geometry=s(e.geometries,this.geometry);let o=this.geometry.parameters;if(o!==void 0&&o.shapes!==void 0){let l=o.shapes;if(Array.isArray(l))for(let u=0,d=l.length;u<d;u++){let p=l[u];s(e.shapes,p)}else s(e.shapes,l)}}if(this.isSkinnedMesh&&(i.bindMode=this.bindMode,i.bindMatrix=this.bindMatrix.toArray(),this.skeleton!==void 0&&(s(e.skeletons,this.skeleton),i.skeleton=this.skeleton.uuid)),this.material!==void 0)if(Array.isArray(this.material)){let o=[];for(let l=0,u=this.material.length;l<u;l++)o.push(s(e.materials,this.material[l]));i.material=o}else i.material=s(e.materials,this.material);if(this.children.length>0){i.children=[];for(let o=0;o<this.children.length;o++)i.children.push(this.children[o].toJSON(e).object)}if(this.animations.length>0){i.animations=[];for(let o=0;o<this.animations.length;o++){let l=this.animations[o];i.animations.push(s(e.animations,l))}}if(a){let o=r(e.geometries),l=r(e.materials),u=r(e.textures),d=r(e.images),p=r(e.shapes),c=r(e.skeletons),h=r(e.animations),v=r(e.nodes);o.length>0&&(n.geometries=o),l.length>0&&(n.materials=l),u.length>0&&(n.textures=u),d.length>0&&(n.images=d),p.length>0&&(n.shapes=p),c.length>0&&(n.skeletons=c),h.length>0&&(n.animations=h),v.length>0&&(n.nodes=v)}return n.object=i,n;function r(o){let l=[];for(let u in o){let d=o[u];delete d.metadata,l.push(d)}return l}}clone(e){return new this.constructor().copy(this,e)}copy(e,a=!0){if(this.name=e.name,this.up.copy(e.up),this.position.copy(e.position),this.rotation.order=e.rotation.order,this.quaternion.copy(e.quaternion),this.scale.copy(e.scale),this.pivot=e.pivot!==null?e.pivot.clone():null,this.matrix.copy(e.matrix),this.matrixWorld.copy(e.matrixWorld),this.matrixAutoUpdate=e.matrixAutoUpdate,this.matrixWorldAutoUpdate=e.matrixWorldAutoUpdate,this.matrixWorldNeedsUpdate=e.matrixWorldNeedsUpdate,this.layers.mask=e.layers.mask,this.visible=e.visible,this.castShadow=e.castShadow,this.receiveShadow=e.receiveShadow,this.frustumCulled=e.frustumCulled,this.renderOrder=e.renderOrder,this.static=e.static,this.animations=e.animations.slice(),this.userData=JSON.parse(JSON.stringify(e.userData)),a===!0)for(let n=0;n<e.children.length;n++){let i=e.children[n];this.add(i.clone())}return this}};en.DEFAULT_UP=new F(0,1,0);en.DEFAULT_MATRIX_AUTO_UPDATE=!0;en.DEFAULT_MATRIX_WORLD_AUTO_UPDATE=!0;var Is=class extends en{constructor(){super(),this.isGroup=!0,this.type="Group"}},zb={type:"move"},br=class{constructor(){this._targetRay=null,this._grip=null,this._hand=null}getHandSpace(){return this._hand===null&&(this._hand=new Is,this._hand.matrixAutoUpdate=!1,this._hand.visible=!1,this._hand.joints={},this._hand.inputState={pinching:!1}),this._hand}getTargetRaySpace(){return this._targetRay===null&&(this._targetRay=new Is,this._targetRay.matrixAutoUpdate=!1,this._targetRay.visible=!1,this._targetRay.hasLinearVelocity=!1,this._targetRay.linearVelocity=new F,this._targetRay.hasAngularVelocity=!1,this._targetRay.angularVelocity=new F),this._targetRay}getGripSpace(){return this._grip===null&&(this._grip=new Is,this._grip.matrixAutoUpdate=!1,this._grip.visible=!1,this._grip.hasLinearVelocity=!1,this._grip.linearVelocity=new F,this._grip.hasAngularVelocity=!1,this._grip.angularVelocity=new F,this._grip.eventsEnabled=!1),this._grip}dispatchEvent(e){return this._targetRay!==null&&this._targetRay.dispatchEvent(e),this._grip!==null&&this._grip.dispatchEvent(e),this._hand!==null&&this._hand.dispatchEvent(e),this}connect(e){if(e&&e.hand){let a=this._hand;if(a)for(let n of e.hand.values())this._getHandJoint(a,n)}return this.dispatchEvent({type:"connected",data:e}),this}disconnect(e){return this.dispatchEvent({type:"disconnected",data:e}),this._targetRay!==null&&(this._targetRay.visible=!1),this._grip!==null&&(this._grip.visible=!1),this._hand!==null&&(this._hand.visible=!1),this}update(e,a,n){let i=null,s=null,r=null,o=this._targetRay,l=this._grip,u=this._hand;if(e&&a.session.visibilityState!=="visible-blurred"){if(u&&e.hand){r=!0;for(let b of e.hand.values()){let m=a.getJointPose(b,n),f=this._getHandJoint(u,b);m!==null&&(f.matrix.fromArray(m.transform.matrix),f.matrix.decompose(f.position,f.rotation,f.scale),f.matrixWorldNeedsUpdate=!0,f.jointRadius=m.radius),f.visible=m!==null}let d=u.joints["index-finger-tip"],p=u.joints["thumb-tip"],c=d.position.distanceTo(p.position),h=.02,v=.005;u.inputState.pinching&&c>h+v?(u.inputState.pinching=!1,this.dispatchEvent({type:"pinchend",handedness:e.handedness,target:this})):!u.inputState.pinching&&c<=h-v&&(u.inputState.pinching=!0,this.dispatchEvent({type:"pinchstart",handedness:e.handedness,target:this}))}else l!==null&&e.gripSpace&&(s=a.getPose(e.gripSpace,n),s!==null&&(l.matrix.fromArray(s.transform.matrix),l.matrix.decompose(l.position,l.rotation,l.scale),l.matrixWorldNeedsUpdate=!0,s.linearVelocity?(l.hasLinearVelocity=!0,l.linearVelocity.copy(s.linearVelocity)):l.hasLinearVelocity=!1,s.angularVelocity?(l.hasAngularVelocity=!0,l.angularVelocity.copy(s.angularVelocity)):l.hasAngularVelocity=!1,l.eventsEnabled&&l.dispatchEvent({type:"gripUpdated",data:e,target:this})));o!==null&&(i=a.getPose(e.targetRaySpace,n),i===null&&s!==null&&(i=s),i!==null&&(o.matrix.fromArray(i.transform.matrix),o.matrix.decompose(o.position,o.rotation,o.scale),o.matrixWorldNeedsUpdate=!0,i.linearVelocity?(o.hasLinearVelocity=!0,o.linearVelocity.copy(i.linearVelocity)):o.hasLinearVelocity=!1,i.angularVelocity?(o.hasAngularVelocity=!0,o.angularVelocity.copy(i.angularVelocity)):o.hasAngularVelocity=!1,this.dispatchEvent(zb)))}return o!==null&&(o.visible=i!==null),l!==null&&(l.visible=s!==null),u!==null&&(u.visible=r!==null),this}_getHandJoint(e,a){if(e.joints[a.jointName]===void 0){let n=new Is;n.matrixAutoUpdate=!1,n.visible=!1,e.joints[a.jointName]=n,e.add(n)}return e.joints[a.jointName]}},A0={aliceblue:15792383,antiquewhite:16444375,aqua:65535,aquamarine:8388564,azure:15794175,beige:16119260,bisque:16770244,black:0,blanchedalmond:16772045,blue:255,blueviolet:9055202,brown:10824234,burlywood:14596231,cadetblue:6266528,chartreuse:8388352,chocolate:13789470,coral:16744272,cornflowerblue:6591981,cornsilk:16775388,crimson:14423100,cyan:65535,darkblue:139,darkcyan:35723,darkgoldenrod:12092939,darkgray:11119017,darkgreen:25600,darkgrey:11119017,darkkhaki:12433259,darkmagenta:9109643,darkolivegreen:5597999,darkorange:16747520,darkorchid:10040012,darkred:9109504,darksalmon:15308410,darkseagreen:9419919,darkslateblue:4734347,darkslategray:3100495,darkslategrey:3100495,darkturquoise:52945,darkviolet:9699539,deeppink:16716947,deepskyblue:49151,dimgray:6908265,dimgrey:6908265,dodgerblue:2003199,firebrick:11674146,floralwhite:16775920,forestgreen:2263842,fuchsia:16711935,gainsboro:14474460,ghostwhite:16316671,gold:16766720,goldenrod:14329120,gray:8421504,green:32768,greenyellow:11403055,grey:8421504,honeydew:15794160,hotpink:16738740,indianred:13458524,indigo:4915330,ivory:16777200,khaki:15787660,lavender:15132410,lavenderblush:16773365,lawngreen:8190976,lemonchiffon:16775885,lightblue:11393254,lightcoral:15761536,lightcyan:14745599,lightgoldenrodyellow:16448210,lightgray:13882323,lightgreen:9498256,lightgrey:13882323,lightpink:16758465,lightsalmon:16752762,lightseagreen:2142890,lightskyblue:8900346,lightslategray:7833753,lightslategrey:7833753,lightsteelblue:11584734,lightyellow:16777184,lime:65280,limegreen:3329330,linen:16445670,magenta:16711935,maroon:8388608,mediumaquamarine:6737322,mediumblue:205,mediumorchid:12211667,mediumpurple:9662683,mediumseagreen:3978097,mediumslateblue:8087790,mediumspringgreen:64154,mediumturquoise:4772300,mediumvioletred:13047173,midnightblue:1644912,mintcream:16121850,mistyrose:16770273,moccasin:16770229,navajowhite:16768685,navy:128,oldlace:16643558,olive:8421376,olivedrab:7048739,orange:16753920,orangered:16729344,orchid:14315734,palegoldenrod:15657130,palegreen:10025880,paleturquoise:11529966,palevioletred:14381203,papayawhip:16773077,peachpuff:16767673,peru:13468991,pink:16761035,plum:14524637,powderblue:11591910,purple:8388736,rebeccapurple:6697881,red:16711680,rosybrown:12357519,royalblue:4286945,saddlebrown:9127187,salmon:16416882,sandybrown:16032864,seagreen:3050327,seashell:16774638,sienna:10506797,silver:12632256,skyblue:8900331,slateblue:6970061,slategray:7372944,slategrey:7372944,snow:16775930,springgreen:65407,steelblue:4620980,tan:13808780,teal:32896,thistle:14204888,tomato:16737095,turquoise:4251856,violet:15631086,wheat:16113331,white:16777215,whitesmoke:16119285,yellow:16776960,yellowgreen:10145074},Ri={h:0,s:0,l:0},xu={h:0,s:0,l:0};function oh(t,e,a){return a<0&&(a+=1),a>1&&(a-=1),a<1/6?t+(e-t)*6*a:a<1/2?e:a<2/3?t+(e-t)*6*(2/3-a):t}var Je=class{constructor(e,a,n){return this.isColor=!0,this.r=1,this.g=1,this.b=1,this.set(e,a,n)}set(e,a,n){if(a===void 0&&n===void 0){let i=e;i&&i.isColor?this.copy(i):typeof i=="number"?this.setHex(i):typeof i=="string"&&this.setStyle(i)}else this.setRGB(e,a,n);return this}setScalar(e){return this.r=e,this.g=e,this.b=e,this}setHex(e,a=ga){return e=Math.floor(e),this.r=(e>>16&255)/255,this.g=(e>>8&255)/255,this.b=(e&255)/255,Ge.colorSpaceToWorking(this,a),this}setRGB(e,a,n,i=Ge.workingColorSpace){return this.r=e,this.g=a,this.b=n,Ge.colorSpaceToWorking(this,i),this}setHSL(e,a,n,i=Ge.workingColorSpace){if(e=Eb(e,1),a=Xe(a,0,1),n=Xe(n,0,1),a===0)this.r=this.g=this.b=n;else{let s=n<=.5?n*(1+a):n+a-n*a,r=2*n-s;this.r=oh(r,s,e+1/3),this.g=oh(r,s,e),this.b=oh(r,s,e-1/3)}return Ge.colorSpaceToWorking(this,i),this}setStyle(e,a=ga){function n(s){s!==void 0&&parseFloat(s)<1&&Ae("Color: Alpha component of "+e+" will be ignored.")}let i;if(i=/^(\w+)\(([^\)]*)\)/.exec(e)){let s,r=i[1],o=i[2];switch(r){case"rgb":case"rgba":if(s=/^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(o))return n(s[4]),this.setRGB(Math.min(255,parseInt(s[1],10))/255,Math.min(255,parseInt(s[2],10))/255,Math.min(255,parseInt(s[3],10))/255,a);if(s=/^\s*(\d+)\%\s*,\s*(\d+)\%\s*,\s*(\d+)\%\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(o))return n(s[4]),this.setRGB(Math.min(100,parseInt(s[1],10))/100,Math.min(100,parseInt(s[2],10))/100,Math.min(100,parseInt(s[3],10))/100,a);break;case"hsl":case"hsla":if(s=/^\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\%\s*,\s*(\d*\.?\d+)\%\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(o))return n(s[4]),this.setHSL(parseFloat(s[1])/360,parseFloat(s[2])/100,parseFloat(s[3])/100,a);break;default:Ae("Color: Unknown color model "+e)}}else if(i=/^\#([A-Fa-f\d]+)$/.exec(e)){let s=i[1],r=s.length;if(r===3)return this.setRGB(parseInt(s.charAt(0),16)/15,parseInt(s.charAt(1),16)/15,parseInt(s.charAt(2),16)/15,a);if(r===6)return this.setHex(parseInt(s,16),a);Ae("Color: Invalid hex color "+e)}else if(e&&e.length>0)return this.setColorName(e,a);return this}setColorName(e,a=ga){let n=A0[e.toLowerCase()];return n!==void 0?this.setHex(n,a):Ae("Color: Unknown color "+e),this}clone(){return new this.constructor(this.r,this.g,this.b)}copy(e){return this.r=e.r,this.g=e.g,this.b=e.b,this}copySRGBToLinear(e){return this.r=ti(e.r),this.g=ti(e.g),this.b=ti(e.b),this}copyLinearToSRGB(e){return this.r=_r(e.r),this.g=_r(e.g),this.b=_r(e.b),this}convertSRGBToLinear(){return this.copySRGBToLinear(this),this}convertLinearToSRGB(){return this.copyLinearToSRGB(this),this}getHex(e=ga){return Ge.workingToColorSpace(da.copy(this),e),Math.round(Xe(da.r*255,0,255))*65536+Math.round(Xe(da.g*255,0,255))*256+Math.round(Xe(da.b*255,0,255))}getHexString(e=ga){return("000000"+this.getHex(e).toString(16)).slice(-6)}getHSL(e,a=Ge.workingColorSpace){Ge.workingToColorSpace(da.copy(this),a);let n=da.r,i=da.g,s=da.b,r=Math.max(n,i,s),o=Math.min(n,i,s),l,u,d=(o+r)/2;if(o===r)l=0,u=0;else{let p=r-o;switch(u=d<=.5?p/(r+o):p/(2-r-o),r){case n:l=(i-s)/p+(i<s?6:0);break;case i:l=(s-n)/p+2;break;case s:l=(n-i)/p+4;break}l/=6}return e.h=l,e.s=u,e.l=d,e}getRGB(e,a=Ge.workingColorSpace){return Ge.workingToColorSpace(da.copy(this),a),e.r=da.r,e.g=da.g,e.b=da.b,e}getStyle(e=ga){Ge.workingToColorSpace(da.copy(this),e);let a=da.r,n=da.g,i=da.b;return e!==ga?`color(${e} ${a.toFixed(3)} ${n.toFixed(3)} ${i.toFixed(3)})`:`rgb(${Math.round(a*255)},${Math.round(n*255)},${Math.round(i*255)})`}offsetHSL(e,a,n){return this.getHSL(Ri),this.setHSL(Ri.h+e,Ri.s+a,Ri.l+n)}add(e){return this.r+=e.r,this.g+=e.g,this.b+=e.b,this}addColors(e,a){return this.r=e.r+a.r,this.g=e.g+a.g,this.b=e.b+a.b,this}addScalar(e){return this.r+=e,this.g+=e,this.b+=e,this}sub(e){return this.r=Math.max(0,this.r-e.r),this.g=Math.max(0,this.g-e.g),this.b=Math.max(0,this.b-e.b),this}multiply(e){return this.r*=e.r,this.g*=e.g,this.b*=e.b,this}multiplyScalar(e){return this.r*=e,this.g*=e,this.b*=e,this}lerp(e,a){return this.r+=(e.r-this.r)*a,this.g+=(e.g-this.g)*a,this.b+=(e.b-this.b)*a,this}lerpColors(e,a,n){return this.r=e.r+(a.r-e.r)*n,this.g=e.g+(a.g-e.g)*n,this.b=e.b+(a.b-e.b)*n,this}lerpHSL(e,a){this.getHSL(Ri),e.getHSL(xu);let n=th(Ri.h,xu.h,a),i=th(Ri.s,xu.s,a),s=th(Ri.l,xu.l,a);return this.setHSL(n,i,s),this}setFromVector3(e){return this.r=e.x,this.g=e.y,this.b=e.z,this}applyMatrix3(e){let a=this.r,n=this.g,i=this.b,s=e.elements;return this.r=s[0]*a+s[3]*n+s[6]*i,this.g=s[1]*a+s[4]*n+s[7]*i,this.b=s[2]*a+s[5]*n+s[8]*i,this}equals(e){return e.r===this.r&&e.g===this.g&&e.b===this.b}fromArray(e,a=0){return this.r=e[a],this.g=e[a+1],this.b=e[a+2],this}toArray(e=[],a=0){return e[a]=this.r,e[a+1]=this.g,e[a+2]=this.b,e}fromBufferAttribute(e,a){return this.r=e.getX(a),this.g=e.getY(a),this.b=e.getZ(a),this}toJSON(){return this.getHex()}*[Symbol.iterator](){yield this.r,yield this.g,yield this.b}},da=new Je;Je.NAMES=A0;var Fo=class extends en{constructor(){super(),this.isScene=!0,this.type="Scene",this.background=null,this.environment=null,this.fog=null,this.backgroundBlurriness=0,this.backgroundIntensity=1,this.backgroundRotation=new Fi,this.environmentIntensity=1,this.environmentRotation=new Fi,this.overrideMaterial=null,typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}copy(e,a){return super.copy(e,a),e.background!==null&&(this.background=e.background.clone()),e.environment!==null&&(this.environment=e.environment.clone()),e.fog!==null&&(this.fog=e.fog.clone()),this.backgroundBlurriness=e.backgroundBlurriness,this.backgroundIntensity=e.backgroundIntensity,this.backgroundRotation.copy(e.backgroundRotation),this.environmentIntensity=e.environmentIntensity,this.environmentRotation.copy(e.environmentRotation),e.overrideMaterial!==null&&(this.overrideMaterial=e.overrideMaterial.clone()),this.matrixAutoUpdate=e.matrixAutoUpdate,this}toJSON(e){let a=super.toJSON(e);return this.fog!==null&&(a.object.fog=this.fog.toJSON()),this.backgroundBlurriness>0&&(a.object.backgroundBlurriness=this.backgroundBlurriness),this.backgroundIntensity!==1&&(a.object.backgroundIntensity=this.backgroundIntensity),a.object.backgroundRotation=this.backgroundRotation.toArray(),this.environmentIntensity!==1&&(a.object.environmentIntensity=this.environmentIntensity),a.object.environmentRotation=this.environmentRotation.toArray(),a}},mn=new F,Qn=new F,lh=new F,jn=new F,dr=new F,hr=new F,Nx=new F,uh=new F,ch=new F,fh=new F,dh=new At,hh=new At,ph=new At,Oi=class t{constructor(e=new F,a=new F,n=new F){this.a=e,this.b=a,this.c=n}static getNormal(e,a,n,i){i.subVectors(n,a),mn.subVectors(e,a),i.cross(mn);let s=i.lengthSq();return s>0?i.multiplyScalar(1/Math.sqrt(s)):i.set(0,0,0)}static getBarycoord(e,a,n,i,s){mn.subVectors(i,a),Qn.subVectors(n,a),lh.subVectors(e,a);let r=mn.dot(mn),o=mn.dot(Qn),l=mn.dot(lh),u=Qn.dot(Qn),d=Qn.dot(lh),p=r*u-o*o;if(p===0)return s.set(0,0,0),null;let c=1/p,h=(u*l-o*d)*c,v=(r*d-o*l)*c;return s.set(1-h-v,v,h)}static containsPoint(e,a,n,i){return this.getBarycoord(e,a,n,i,jn)===null?!1:jn.x>=0&&jn.y>=0&&jn.x+jn.y<=1}static getInterpolation(e,a,n,i,s,r,o,l){return this.getBarycoord(e,a,n,i,jn)===null?(l.x=0,l.y=0,"z"in l&&(l.z=0),"w"in l&&(l.w=0),null):(l.setScalar(0),l.addScaledVector(s,jn.x),l.addScaledVector(r,jn.y),l.addScaledVector(o,jn.z),l)}static getInterpolatedAttribute(e,a,n,i,s,r){return dh.setScalar(0),hh.setScalar(0),ph.setScalar(0),dh.fromBufferAttribute(e,a),hh.fromBufferAttribute(e,n),ph.fromBufferAttribute(e,i),r.setScalar(0),r.addScaledVector(dh,s.x),r.addScaledVector(hh,s.y),r.addScaledVector(ph,s.z),r}static isFrontFacing(e,a,n,i){return mn.subVectors(n,a),Qn.subVectors(e,a),mn.cross(Qn).dot(i)<0}set(e,a,n){return this.a.copy(e),this.b.copy(a),this.c.copy(n),this}setFromPointsAndIndices(e,a,n,i){return this.a.copy(e[a]),this.b.copy(e[n]),this.c.copy(e[i]),this}setFromAttributeAndIndices(e,a,n,i){return this.a.fromBufferAttribute(e,a),this.b.fromBufferAttribute(e,n),this.c.fromBufferAttribute(e,i),this}clone(){return new this.constructor().copy(this)}copy(e){return this.a.copy(e.a),this.b.copy(e.b),this.c.copy(e.c),this}getArea(){return mn.subVectors(this.c,this.b),Qn.subVectors(this.a,this.b),mn.cross(Qn).length()*.5}getMidpoint(e){return e.addVectors(this.a,this.b).add(this.c).multiplyScalar(1/3)}getNormal(e){return t.getNormal(this.a,this.b,this.c,e)}getPlane(e){return e.setFromCoplanarPoints(this.a,this.b,this.c)}getBarycoord(e,a){return t.getBarycoord(e,this.a,this.b,this.c,a)}getInterpolation(e,a,n,i,s){return t.getInterpolation(e,this.a,this.b,this.c,a,n,i,s)}containsPoint(e){return t.containsPoint(e,this.a,this.b,this.c)}isFrontFacing(e){return t.isFrontFacing(this.a,this.b,this.c,e)}intersectsBox(e){return e.intersectsTriangle(this)}closestPointToPoint(e,a){let n=this.a,i=this.b,s=this.c,r,o;dr.subVectors(i,n),hr.subVectors(s,n),uh.subVectors(e,n);let l=dr.dot(uh),u=hr.dot(uh);if(l<=0&&u<=0)return a.copy(n);ch.subVectors(e,i);let d=dr.dot(ch),p=hr.dot(ch);if(d>=0&&p<=d)return a.copy(i);let c=l*p-d*u;if(c<=0&&l>=0&&d<=0)return r=l/(l-d),a.copy(n).addScaledVector(dr,r);fh.subVectors(e,s);let h=dr.dot(fh),v=hr.dot(fh);if(v>=0&&h<=v)return a.copy(s);let b=h*u-l*v;if(b<=0&&u>=0&&v<=0)return o=u/(u-v),a.copy(n).addScaledVector(hr,o);let m=d*v-h*p;if(m<=0&&p-d>=0&&h-v>=0)return Nx.subVectors(s,i),o=(p-d)/(p-d+(h-v)),a.copy(i).addScaledVector(Nx,o);let f=1/(m+b+c);return r=b*f,o=c*f,a.copy(n).addScaledVector(dr,r).addScaledVector(hr,o)}equals(e){return e.a.equals(this.a)&&e.b.equals(this.b)&&e.c.equals(this.c)}},zi=class{constructor(e=new F(1/0,1/0,1/0),a=new F(-1/0,-1/0,-1/0)){this.isBox3=!0,this.min=e,this.max=a}set(e,a){return this.min.copy(e),this.max.copy(a),this}setFromArray(e){this.makeEmpty();for(let a=0,n=e.length;a<n;a+=3)this.expandByPoint(gn.fromArray(e,a));return this}setFromBufferAttribute(e){this.makeEmpty();for(let a=0,n=e.count;a<n;a++)this.expandByPoint(gn.fromBufferAttribute(e,a));return this}setFromPoints(e){this.makeEmpty();for(let a=0,n=e.length;a<n;a++)this.expandByPoint(e[a]);return this}setFromCenterAndSize(e,a){let n=gn.copy(a).multiplyScalar(.5);return this.min.copy(e).sub(n),this.max.copy(e).add(n),this}setFromObject(e,a=!1){return this.makeEmpty(),this.expandByObject(e,a)}clone(){return new this.constructor().copy(this)}copy(e){return this.min.copy(e.min),this.max.copy(e.max),this}makeEmpty(){return this.min.x=this.min.y=this.min.z=1/0,this.max.x=this.max.y=this.max.z=-1/0,this}isEmpty(){return this.max.x<this.min.x||this.max.y<this.min.y||this.max.z<this.min.z}getCenter(e){return this.isEmpty()?e.set(0,0,0):e.addVectors(this.min,this.max).multiplyScalar(.5)}getSize(e){return this.isEmpty()?e.set(0,0,0):e.subVectors(this.max,this.min)}expandByPoint(e){return this.min.min(e),this.max.max(e),this}expandByVector(e){return this.min.sub(e),this.max.add(e),this}expandByScalar(e){return this.min.addScalar(-e),this.max.addScalar(e),this}expandByObject(e,a=!1){e.updateWorldMatrix(!1,!1);let n=e.geometry;if(n!==void 0){let s=n.getAttribute("position");if(a===!0&&s!==void 0&&e.isInstancedMesh!==!0)for(let r=0,o=s.count;r<o;r++)e.isMesh===!0?e.getVertexPosition(r,gn):gn.fromBufferAttribute(s,r),gn.applyMatrix4(e.matrixWorld),this.expandByPoint(gn);else e.boundingBox!==void 0?(e.boundingBox===null&&e.computeBoundingBox(),vu.copy(e.boundingBox)):(n.boundingBox===null&&n.computeBoundingBox(),vu.copy(n.boundingBox)),vu.applyMatrix4(e.matrixWorld),this.union(vu)}let i=e.children;for(let s=0,r=i.length;s<r;s++)this.expandByObject(i[s],a);return this}containsPoint(e){return e.x>=this.min.x&&e.x<=this.max.x&&e.y>=this.min.y&&e.y<=this.max.y&&e.z>=this.min.z&&e.z<=this.max.z}containsBox(e){return this.min.x<=e.min.x&&e.max.x<=this.max.x&&this.min.y<=e.min.y&&e.max.y<=this.max.y&&this.min.z<=e.min.z&&e.max.z<=this.max.z}getParameter(e,a){return a.set((e.x-this.min.x)/(this.max.x-this.min.x),(e.y-this.min.y)/(this.max.y-this.min.y),(e.z-this.min.z)/(this.max.z-this.min.z))}intersectsBox(e){return e.max.x>=this.min.x&&e.min.x<=this.max.x&&e.max.y>=this.min.y&&e.min.y<=this.max.y&&e.max.z>=this.min.z&&e.min.z<=this.max.z}intersectsSphere(e){return this.clampPoint(e.center,gn),gn.distanceToSquared(e.center)<=e.radius*e.radius}intersectsPlane(e){let a,n;return e.normal.x>0?(a=e.normal.x*this.min.x,n=e.normal.x*this.max.x):(a=e.normal.x*this.max.x,n=e.normal.x*this.min.x),e.normal.y>0?(a+=e.normal.y*this.min.y,n+=e.normal.y*this.max.y):(a+=e.normal.y*this.max.y,n+=e.normal.y*this.min.y),e.normal.z>0?(a+=e.normal.z*this.min.z,n+=e.normal.z*this.max.z):(a+=e.normal.z*this.max.z,n+=e.normal.z*this.min.z),a<=-e.constant&&n>=-e.constant}intersectsTriangle(e){if(this.isEmpty())return!1;this.getCenter(Io),yu.subVectors(this.max,Io),pr.subVectors(e.a,Io),mr.subVectors(e.b,Io),gr.subVectors(e.c,Io),Di.subVectors(mr,pr),Pi.subVectors(gr,mr),bs.subVectors(pr,gr);let a=[0,-Di.z,Di.y,0,-Pi.z,Pi.y,0,-bs.z,bs.y,Di.z,0,-Di.x,Pi.z,0,-Pi.x,bs.z,0,-bs.x,-Di.y,Di.x,0,-Pi.y,Pi.x,0,-bs.y,bs.x,0];return!mh(a,pr,mr,gr,yu)||(a=[1,0,0,0,1,0,0,0,1],!mh(a,pr,mr,gr,yu))?!1:(_u.crossVectors(Di,Pi),a=[_u.x,_u.y,_u.z],mh(a,pr,mr,gr,yu))}clampPoint(e,a){return a.copy(e).clamp(this.min,this.max)}distanceToPoint(e){return this.clampPoint(e,gn).distanceTo(e)}getBoundingSphere(e){return this.isEmpty()?e.makeEmpty():(this.getCenter(e.center),e.radius=this.getSize(gn).length()*.5),e}intersect(e){return this.min.max(e.min),this.max.min(e.max),this.isEmpty()&&this.makeEmpty(),this}union(e){return this.min.min(e.min),this.max.max(e.max),this}applyMatrix4(e){return this.isEmpty()?this:($n[0].set(this.min.x,this.min.y,this.min.z).applyMatrix4(e),$n[1].set(this.min.x,this.min.y,this.max.z).applyMatrix4(e),$n[2].set(this.min.x,this.max.y,this.min.z).applyMatrix4(e),$n[3].set(this.min.x,this.max.y,this.max.z).applyMatrix4(e),$n[4].set(this.max.x,this.min.y,this.min.z).applyMatrix4(e),$n[5].set(this.max.x,this.min.y,this.max.z).applyMatrix4(e),$n[6].set(this.max.x,this.max.y,this.min.z).applyMatrix4(e),$n[7].set(this.max.x,this.max.y,this.max.z).applyMatrix4(e),this.setFromPoints($n),this)}translate(e){return this.min.add(e),this.max.add(e),this}equals(e){return e.min.equals(this.min)&&e.max.equals(this.max)}toJSON(){return{min:this.min.toArray(),max:this.max.toArray()}}fromJSON(e){return this.min.fromArray(e.min),this.max.fromArray(e.max),this}},$n=[new F,new F,new F,new F,new F,new F,new F,new F],gn=new F,vu=new zi,pr=new F,mr=new F,gr=new F,Di=new F,Pi=new F,bs=new F,Io=new F,yu=new F,_u=new F,Cs=new F;function mh(t,e,a,n,i){for(let s=0,r=t.length-3;s<=r;s+=3){Cs.fromArray(t,s);let o=i.x*Math.abs(Cs.x)+i.y*Math.abs(Cs.y)+i.z*Math.abs(Cs.z),l=e.dot(Cs),u=a.dot(Cs),d=n.dot(Cs);if(Math.max(-Math.max(l,u,d),Math.min(l,u,d))>o)return!1}return!0}var Ht=new F,Su=new qe,kb=0,Na=class extends Pn{constructor(e,a,n=!1){if(super(),Array.isArray(e))throw new TypeError("THREE.BufferAttribute: array should be a Typed Array.");this.isBufferAttribute=!0,Object.defineProperty(this,"id",{value:kb++}),this.name="",this.array=e,this.itemSize=a,this.count=e!==void 0?e.length/a:0,this.normalized=n,this.usage=Ih,this.updateRanges=[],this.gpuType=_n,this.version=0}onUploadCallback(){}set needsUpdate(e){e===!0&&this.version++}setUsage(e){return this.usage=e,this}addUpdateRange(e,a){this.updateRanges.push({start:e,count:a})}clearUpdateRanges(){this.updateRanges.length=0}copy(e){return this.name=e.name,this.array=new e.array.constructor(e.array),this.itemSize=e.itemSize,this.count=e.count,this.normalized=e.normalized,this.usage=e.usage,this.gpuType=e.gpuType,this}copyAt(e,a,n){e*=this.itemSize,n*=a.itemSize;for(let i=0,s=this.itemSize;i<s;i++)this.array[e+i]=a.array[n+i];return this}copyArray(e){return this.array.set(e),this}applyMatrix3(e){if(this.itemSize===2)for(let a=0,n=this.count;a<n;a++)Su.fromBufferAttribute(this,a),Su.applyMatrix3(e),this.setXY(a,Su.x,Su.y);else if(this.itemSize===3)for(let a=0,n=this.count;a<n;a++)Ht.fromBufferAttribute(this,a),Ht.applyMatrix3(e),this.setXYZ(a,Ht.x,Ht.y,Ht.z);return this}applyMatrix4(e){for(let a=0,n=this.count;a<n;a++)Ht.fromBufferAttribute(this,a),Ht.applyMatrix4(e),this.setXYZ(a,Ht.x,Ht.y,Ht.z);return this}applyNormalMatrix(e){for(let a=0,n=this.count;a<n;a++)Ht.fromBufferAttribute(this,a),Ht.applyNormalMatrix(e),this.setXYZ(a,Ht.x,Ht.y,Ht.z);return this}transformDirection(e){for(let a=0,n=this.count;a<n;a++)Ht.fromBufferAttribute(this,a),Ht.transformDirection(e),this.setXYZ(a,Ht.x,Ht.y,Ht.z);return this}set(e,a=0){return this.array.set(e,a),this}getComponent(e,a){let n=this.array[e*this.itemSize+a];return this.normalized&&(n=Ao(n,this.array)),n}setComponent(e,a,n){return this.normalized&&(n=ba(n,this.array)),this.array[e*this.itemSize+a]=n,this}getX(e){let a=this.array[e*this.itemSize];return this.normalized&&(a=Ao(a,this.array)),a}setX(e,a){return this.normalized&&(a=ba(a,this.array)),this.array[e*this.itemSize]=a,this}getY(e){let a=this.array[e*this.itemSize+1];return this.normalized&&(a=Ao(a,this.array)),a}setY(e,a){return this.normalized&&(a=ba(a,this.array)),this.array[e*this.itemSize+1]=a,this}getZ(e){let a=this.array[e*this.itemSize+2];return this.normalized&&(a=Ao(a,this.array)),a}setZ(e,a){return this.normalized&&(a=ba(a,this.array)),this.array[e*this.itemSize+2]=a,this}getW(e){let a=this.array[e*this.itemSize+3];return this.normalized&&(a=Ao(a,this.array)),a}setW(e,a){return this.normalized&&(a=ba(a,this.array)),this.array[e*this.itemSize+3]=a,this}setXY(e,a,n){return e*=this.itemSize,this.normalized&&(a=ba(a,this.array),n=ba(n,this.array)),this.array[e+0]=a,this.array[e+1]=n,this}setXYZ(e,a,n,i){return e*=this.itemSize,this.normalized&&(a=ba(a,this.array),n=ba(n,this.array),i=ba(i,this.array)),this.array[e+0]=a,this.array[e+1]=n,this.array[e+2]=i,this}setXYZW(e,a,n,i,s){return e*=this.itemSize,this.normalized&&(a=ba(a,this.array),n=ba(n,this.array),i=ba(i,this.array),s=ba(s,this.array)),this.array[e+0]=a,this.array[e+1]=n,this.array[e+2]=i,this.array[e+3]=s,this}onUpload(e){return this.onUploadCallback=e,this}clone(){return new this.constructor(this.array,this.itemSize).copy(this)}toJSON(){let e={itemSize:this.itemSize,type:this.array.constructor.name,array:Array.from(this.array),normalized:this.normalized};return this.name!==""&&(e.name=this.name),this.usage!==Ih&&(e.usage=this.usage),e}dispose(){this.dispatchEvent({type:"dispose"})}};var zo=class extends Na{constructor(e,a,n){super(new Uint16Array(e),a,n)}};var ko=class extends Na{constructor(e,a,n){super(new Uint32Array(e),a,n)}};var $a=class extends Na{constructor(e,a,n){super(new Float32Array(e),a,n)}},Hb=new zi,Eo=new F,gh=new F,Cr=class{constructor(e=new F,a=-1){this.isSphere=!0,this.center=e,this.radius=a}set(e,a){return this.center.copy(e),this.radius=a,this}setFromPoints(e,a){let n=this.center;a!==void 0?n.copy(a):Hb.setFromPoints(e).getCenter(n);let i=0;for(let s=0,r=e.length;s<r;s++)i=Math.max(i,n.distanceToSquared(e[s]));return this.radius=Math.sqrt(i),this}copy(e){return this.center.copy(e.center),this.radius=e.radius,this}isEmpty(){return this.radius<0}makeEmpty(){return this.center.set(0,0,0),this.radius=-1,this}containsPoint(e){return e.distanceToSquared(this.center)<=this.radius*this.radius}distanceToPoint(e){return e.distanceTo(this.center)-this.radius}intersectsSphere(e){let a=this.radius+e.radius;return e.center.distanceToSquared(this.center)<=a*a}intersectsBox(e){return e.intersectsSphere(this)}intersectsPlane(e){return Math.abs(e.distanceToPoint(this.center))<=this.radius}clampPoint(e,a){let n=this.center.distanceToSquared(e);return a.copy(e),n>this.radius*this.radius&&(a.sub(this.center).normalize(),a.multiplyScalar(this.radius).add(this.center)),a}getBoundingBox(e){return this.isEmpty()?(e.makeEmpty(),e):(e.set(this.center,this.center),e.expandByScalar(this.radius),e)}applyMatrix4(e){return this.center.applyMatrix4(e),this.radius=this.radius*e.getMaxScaleOnAxis(),this}translate(e){return this.center.add(e),this}expandByPoint(e){if(this.isEmpty())return this.center.copy(e),this.radius=0,this;Eo.subVectors(e,this.center);let a=Eo.lengthSq();if(a>this.radius*this.radius){let n=Math.sqrt(a),i=(n-this.radius)*.5;this.center.addScaledVector(Eo,i/n),this.radius+=i}return this}union(e){return e.isEmpty()?this:this.isEmpty()?(this.copy(e),this):(this.center.equals(e.center)===!0?this.radius=Math.max(this.radius,e.radius):(gh.subVectors(e.center,this.center).setLength(e.radius),this.expandByPoint(Eo.copy(e.center).add(gh)),this.expandByPoint(Eo.copy(e.center).sub(gh))),this)}equals(e){return e.center.equals(this.center)&&e.radius===this.radius}clone(){return new this.constructor().copy(this)}toJSON(){return{radius:this.radius,center:this.center.toArray()}}fromJSON(e){return this.radius=e.radius,this.center.fromArray(e.center),this}},Vb=0,ja=new Ot,xh=new en,xr=new F,Oa=new zi,wo=new zi,jt=new F,Bn=class t extends Pn{constructor(){super(),this.isBufferGeometry=!0,Object.defineProperty(this,"id",{value:Vb++}),this.uuid=il(),this.name="",this.type="BufferGeometry",this.index=null,this.indirect=null,this.indirectOffset=0,this.attributes={},this.morphAttributes={},this.morphTargetsRelative=!1,this.groups=[],this.boundingBox=null,this.boundingSphere=null,this.drawRange={start:0,count:1/0},this.userData={},this._transformed=!1}getIndex(){return this.index}setIndex(e){return Array.isArray(e)?this.index=new(Tb(e)?ko:zo)(e,1):this.index=e,this}setIndirect(e,a=0){return this.indirect=e,this.indirectOffset=a,this}getIndirect(){return this.indirect}getAttribute(e){return this.attributes[e]}setAttribute(e,a){return this.attributes[e]=a,this}deleteAttribute(e){return delete this.attributes[e],this}hasAttribute(e){return this.attributes[e]!==void 0}addGroup(e,a,n=0){this.groups.push({start:e,count:a,materialIndex:n})}clearGroups(){this.groups=[]}setDrawRange(e,a){this.drawRange.start=e,this.drawRange.count=a}applyMatrix4(e){let a=this.attributes.position;a!==void 0&&(a.applyMatrix4(e),a.needsUpdate=!0);let n=this.attributes.normal;if(n!==void 0){let s=new De().getNormalMatrix(e);n.applyNormalMatrix(s),n.needsUpdate=!0}let i=this.attributes.tangent;return i!==void 0&&(i.transformDirection(e),i.needsUpdate=!0),this.boundingBox!==null&&this.computeBoundingBox(),this.boundingSphere!==null&&this.computeBoundingSphere(),this._transformed=!0,this}applyQuaternion(e){return ja.makeRotationFromQuaternion(e),this.applyMatrix4(ja),this}rotateX(e){return ja.makeRotationX(e),this.applyMatrix4(ja),this}rotateY(e){return ja.makeRotationY(e),this.applyMatrix4(ja),this}rotateZ(e){return ja.makeRotationZ(e),this.applyMatrix4(ja),this}translate(e,a,n){return ja.makeTranslation(e,a,n),this.applyMatrix4(ja),this}scale(e,a,n){return ja.makeScale(e,a,n),this.applyMatrix4(ja),this}lookAt(e){return xh.lookAt(e),xh.updateMatrix(),this.applyMatrix4(xh.matrix),this}center(){return this.computeBoundingBox(),this.boundingBox.getCenter(xr).negate(),this.translate(xr.x,xr.y,xr.z),this}setFromPoints(e){let a=this.getAttribute("position");if(a===void 0){let n=[];for(let i=0,s=e.length;i<s;i++){let r=e[i];n.push(r.x,r.y,r.z||0)}this.setAttribute("position",new $a(n,3))}else{let n=Math.min(e.length,a.count);for(let i=0;i<n;i++){let s=e[i];a.setXYZ(i,s.x,s.y,s.z||0)}e.length>a.count&&Ae("BufferGeometry: Buffer size too small for points data. Use .dispose() and create a new geometry."),a.needsUpdate=!0}return this}computeBoundingBox(){this.boundingBox===null&&(this.boundingBox=new zi);let e=this.attributes.position,a=this.morphAttributes.position;if(e&&e.isGLBufferAttribute){Ee("BufferGeometry.computeBoundingBox(): GLBufferAttribute requires a manual bounding box.",this),this.boundingBox.set(new F(-1/0,-1/0,-1/0),new F(1/0,1/0,1/0));return}if(e!==void 0){if(this.boundingBox.setFromBufferAttribute(e),a)for(let n=0,i=a.length;n<i;n++){let s=a[n];Oa.setFromBufferAttribute(s),this.morphTargetsRelative?(jt.addVectors(this.boundingBox.min,Oa.min),this.boundingBox.expandByPoint(jt),jt.addVectors(this.boundingBox.max,Oa.max),this.boundingBox.expandByPoint(jt)):(this.boundingBox.expandByPoint(Oa.min),this.boundingBox.expandByPoint(Oa.max))}}else this.boundingBox.makeEmpty();(isNaN(this.boundingBox.min.x)||isNaN(this.boundingBox.min.y)||isNaN(this.boundingBox.min.z))&&Ee('BufferGeometry.computeBoundingBox(): Computed min/max have NaN values. The "position" attribute is likely to have NaN values.',this)}computeBoundingSphere(){this.boundingSphere===null&&(this.boundingSphere=new Cr);let e=this.attributes.position,a=this.morphAttributes.position;if(e&&e.isGLBufferAttribute){Ee("BufferGeometry.computeBoundingSphere(): GLBufferAttribute requires a manual bounding sphere.",this),this.boundingSphere.set(new F,1/0);return}if(e){let n=this.boundingSphere.center;if(Oa.setFromBufferAttribute(e),a)for(let s=0,r=a.length;s<r;s++){let o=a[s];wo.setFromBufferAttribute(o),this.morphTargetsRelative?(jt.addVectors(Oa.min,wo.min),Oa.expandByPoint(jt),jt.addVectors(Oa.max,wo.max),Oa.expandByPoint(jt)):(Oa.expandByPoint(wo.min),Oa.expandByPoint(wo.max))}Oa.getCenter(n);let i=0;for(let s=0,r=e.count;s<r;s++)jt.fromBufferAttribute(e,s),i=Math.max(i,n.distanceToSquared(jt));if(a)for(let s=0,r=a.length;s<r;s++){let o=a[s],l=this.morphTargetsRelative;for(let u=0,d=o.count;u<d;u++)jt.fromBufferAttribute(o,u),l&&(xr.fromBufferAttribute(e,u),jt.add(xr)),i=Math.max(i,n.distanceToSquared(jt))}this.boundingSphere.radius=Math.sqrt(i),isNaN(this.boundingSphere.radius)&&Ee('BufferGeometry.computeBoundingSphere(): Computed radius is NaN. The "position" attribute is likely to have NaN values.',this)}}computeTangents(){let e=this.index,a=this.attributes;if(e===null||a.position===void 0||a.normal===void 0||a.uv===void 0){Ee("BufferGeometry: .computeTangents() failed. Missing required attributes (index, position, normal or uv)");return}let n=a.position,i=a.normal,s=a.uv,r=this.getAttribute("tangent");(r===void 0||r.count!==n.count)&&(r=new Na(new Float32Array(4*n.count),4),this.setAttribute("tangent",r));let o=[],l=[];for(let y=0;y<n.count;y++)o[y]=new F,l[y]=new F;let u=new F,d=new F,p=new F,c=new qe,h=new qe,v=new qe,b=new F,m=new F;function f(y,A,E){u.fromBufferAttribute(n,y),d.fromBufferAttribute(n,A),p.fromBufferAttribute(n,E),c.fromBufferAttribute(s,y),h.fromBufferAttribute(s,A),v.fromBufferAttribute(s,E),d.sub(u),p.sub(u),h.sub(c),v.sub(c);let w=1/(h.x*v.y-v.x*h.y);isFinite(w)&&(b.copy(d).multiplyScalar(v.y).addScaledVector(p,-h.y).multiplyScalar(w),m.copy(p).multiplyScalar(h.x).addScaledVector(d,-v.x).multiplyScalar(w),o[y].add(b),o[A].add(b),o[E].add(b),l[y].add(m),l[A].add(m),l[E].add(m))}let x=this.groups;x.length===0&&(x=[{start:0,count:e.count}]);for(let y=0,A=x.length;y<A;++y){let E=x[y],w=E.start,B=E.count;for(let X=w,K=w+B;X<K;X+=3)f(e.getX(X+0),e.getX(X+1),e.getX(X+2))}let S=new F,_=new F,L=new F,C=new F;function T(y){L.fromBufferAttribute(i,y),C.copy(L);let A=o[y];S.copy(A),S.sub(L.multiplyScalar(L.dot(A))).normalize(),_.crossVectors(C,A);let w=_.dot(l[y])<0?-1:1;r.setXYZW(y,S.x,S.y,S.z,w)}for(let y=0,A=x.length;y<A;++y){let E=x[y],w=E.start,B=E.count;for(let X=w,K=w+B;X<K;X+=3)T(e.getX(X+0)),T(e.getX(X+1)),T(e.getX(X+2))}this._transformed=!0}computeVertexNormals(){let e=this.index,a=this.getAttribute("position");if(a!==void 0){let n=this.getAttribute("normal");if(n===void 0||n.count!==a.count)n=new Na(new Float32Array(a.count*3),3),this.setAttribute("normal",n);else for(let c=0,h=n.count;c<h;c++)n.setXYZ(c,0,0,0);let i=new F,s=new F,r=new F,o=new F,l=new F,u=new F,d=new F,p=new F;if(e)for(let c=0,h=e.count;c<h;c+=3){let v=e.getX(c+0),b=e.getX(c+1),m=e.getX(c+2);i.fromBufferAttribute(a,v),s.fromBufferAttribute(a,b),r.fromBufferAttribute(a,m),d.subVectors(r,s),p.subVectors(i,s),d.cross(p),o.fromBufferAttribute(n,v),l.fromBufferAttribute(n,b),u.fromBufferAttribute(n,m),o.add(d),l.add(d),u.add(d),n.setXYZ(v,o.x,o.y,o.z),n.setXYZ(b,l.x,l.y,l.z),n.setXYZ(m,u.x,u.y,u.z)}else for(let c=0,h=a.count;c<h;c+=3)i.fromBufferAttribute(a,c+0),s.fromBufferAttribute(a,c+1),r.fromBufferAttribute(a,c+2),d.subVectors(r,s),p.subVectors(i,s),d.cross(p),n.setXYZ(c+0,d.x,d.y,d.z),n.setXYZ(c+1,d.x,d.y,d.z),n.setXYZ(c+2,d.x,d.y,d.z);this.normalizeNormals(),n.needsUpdate=!0}}normalizeNormals(){let e=this.attributes.normal;for(let a=0,n=e.count;a<n;a++)jt.fromBufferAttribute(e,a),jt.normalize(),e.setXYZ(a,jt.x,jt.y,jt.z)}toNonIndexed(){function e(o,l){let u=o.array,d=o.itemSize,p=o.normalized,c=new u.constructor(l.length*d),h=0,v=0;for(let b=0,m=l.length;b<m;b++){o.isInterleavedBufferAttribute?h=l[b]*o.data.stride+o.offset:h=l[b]*d;for(let f=0;f<d;f++)c[v++]=u[h++]}return new Na(c,d,p)}if(this.index===null)return Ae("BufferGeometry.toNonIndexed(): BufferGeometry is already non-indexed."),this;let a=new t,n=this.index.array,i=this.attributes;for(let o in i){let l=i[o],u=e(l,n);a.setAttribute(o,u)}let s=this.morphAttributes;for(let o in s){let l=[],u=s[o];for(let d=0,p=u.length;d<p;d++){let c=u[d],h=e(c,n);l.push(h)}a.morphAttributes[o]=l}a.morphTargetsRelative=this.morphTargetsRelative;let r=this.groups;for(let o=0,l=r.length;o<l;o++){let u=r[o];a.addGroup(u.start,u.count,u.materialIndex)}return a}toJSON(){let e={metadata:{version:4.7,type:"BufferGeometry",generator:"BufferGeometry.toJSON"}};if(e.uuid=this.uuid,e.type=this.parameters!==void 0&&this._transformed===!0?"BufferGeometry":this.type,this.name!==""&&(e.name=this.name),Object.keys(this.userData).length>0&&(e.userData=this.userData),this.parameters!==void 0&&this._transformed!==!0){let l=this.parameters;for(let u in l)l[u]!==void 0&&(e[u]=l[u]);return e}e.data={attributes:{}};let a=this.index;a!==null&&(e.data.index={type:a.array.constructor.name,array:Array.prototype.slice.call(a.array)});let n=this.attributes;for(let l in n){let u=n[l];e.data.attributes[l]=u.toJSON(e.data)}let i={},s=!1;for(let l in this.morphAttributes){let u=this.morphAttributes[l],d=[];for(let p=0,c=u.length;p<c;p++){let h=u[p];d.push(h.toJSON(e.data))}d.length>0&&(i[l]=d,s=!0)}s&&(e.data.morphAttributes=i,e.data.morphTargetsRelative=this.morphTargetsRelative);let r=this.groups;r.length>0&&(e.data.groups=JSON.parse(JSON.stringify(r)));let o=this.boundingSphere;return o!==null&&(e.data.boundingSphere=o.toJSON()),e}clone(){return new this.constructor().copy(this)}copy(e){this.index=null,this.attributes={},this.morphAttributes={},this.groups=[],this.boundingBox=null,this.boundingSphere=null;let a={};this.name=e.name;let n=e.index;n!==null&&this.setIndex(n.clone());let i=e.attributes;for(let u in i){let d=i[u];this.setAttribute(u,d.clone(a))}let s=e.morphAttributes;for(let u in s){let d=[],p=s[u];for(let c=0,h=p.length;c<h;c++)d.push(p[c].clone(a));this.morphAttributes[u]=d}this.morphTargetsRelative=e.morphTargetsRelative;let r=e.groups;for(let u=0,d=r.length;u<d;u++){let p=r[u];this.addGroup(p.start,p.count,p.materialIndex)}let o=e.boundingBox;o!==null&&(this.boundingBox=o.clone());let l=e.boundingSphere;return l!==null&&(this.boundingSphere=l.clone()),this.drawRange.start=e.drawRange.start,this.drawRange.count=e.drawRange.count,this.userData=e.userData,this._transformed=e._transformed,this}dispose(){this.dispatchEvent({type:"dispose"})}};var Gb=0,Ds=class extends Pn{constructor(){super(),this.isMaterial=!0,Object.defineProperty(this,"id",{value:Gb++}),this.uuid=il(),this.name="",this.type="Material",this.blending=ws,this.side=ai,this.vertexColors=!1,this.opacity=1,this.transparent=!1,this.alphaHash=!1,this.blendSrc=Ou,this.blendDst=Nu,this.blendEquation=Ni,this.blendSrcAlpha=null,this.blendDstAlpha=null,this.blendEquationAlpha=null,this.blendColor=new Je(0,0,0),this.blendAlpha=0,this.depthFunc=Rs,this.depthTest=!0,this.depthWrite=!0,this.stencilWriteMask=255,this.stencilFunc=Th,this.stencilRef=0,this.stencilFuncMask=255,this.stencilFail=Ts,this.stencilZFail=Ts,this.stencilZPass=Ts,this.stencilWrite=!1,this.clippingPlanes=null,this.clipIntersection=!1,this.clipShadows=!1,this.shadowSide=null,this.colorWrite=!0,this.precision=null,this.polygonOffset=!1,this.polygonOffsetFactor=0,this.polygonOffsetUnits=0,this.dithering=!1,this.alphaToCoverage=!1,this.premultipliedAlpha=!1,this.forceSinglePass=!1,this.allowOverride=!0,this.visible=!0,this.toneMapped=!0,this.userData={},this.version=0,this._alphaTest=0}get alphaTest(){return this._alphaTest}set alphaTest(e){this._alphaTest>0!=e>0&&this.version++,this._alphaTest=e}onBeforeRender(){}onBeforeCompile(){}customProgramCacheKey(){return this.onBeforeCompile.toString()}setValues(e){if(e!==void 0)for(let a in e){let n=e[a];if(n===void 0){Ae(`Material: parameter '${a}' has value of undefined.`);continue}let i=this[a];if(i===void 0){Ae(`Material: '${a}' is not a property of THREE.${this.type}.`);continue}i&&i.isColor?i.set(n):i&&i.isVector2&&n&&n.isVector2||i&&i.isEuler&&n&&n.isEuler||i&&i.isVector3&&n&&n.isVector3?i.copy(n):this[a]=n}}toJSON(e){let a=e===void 0||typeof e=="string";a&&(e={textures:{},images:{}});let n={metadata:{version:4.7,type:"Material",generator:"Material.toJSON"}};n.uuid=this.uuid,n.type=this.type,this.name!==""&&(n.name=this.name),this.color&&this.color.isColor&&(n.color=this.color.getHex()),this.roughness!==void 0&&(n.roughness=this.roughness),this.metalness!==void 0&&(n.metalness=this.metalness),this.sheen!==void 0&&(n.sheen=this.sheen),this.sheenColor&&this.sheenColor.isColor&&(n.sheenColor=this.sheenColor.getHex()),this.sheenRoughness!==void 0&&(n.sheenRoughness=this.sheenRoughness),this.emissive&&this.emissive.isColor&&(n.emissive=this.emissive.getHex()),this.emissiveIntensity!==void 0&&this.emissiveIntensity!==1&&(n.emissiveIntensity=this.emissiveIntensity),this.specular&&this.specular.isColor&&(n.specular=this.specular.getHex()),this.specularIntensity!==void 0&&(n.specularIntensity=this.specularIntensity),this.specularColor&&this.specularColor.isColor&&(n.specularColor=this.specularColor.getHex()),this.shininess!==void 0&&(n.shininess=this.shininess),this.clearcoat!==void 0&&(n.clearcoat=this.clearcoat),this.clearcoatRoughness!==void 0&&(n.clearcoatRoughness=this.clearcoatRoughness),this.clearcoatMap&&this.clearcoatMap.isTexture&&(n.clearcoatMap=this.clearcoatMap.toJSON(e).uuid),this.clearcoatRoughnessMap&&this.clearcoatRoughnessMap.isTexture&&(n.clearcoatRoughnessMap=this.clearcoatRoughnessMap.toJSON(e).uuid),this.clearcoatNormalMap&&this.clearcoatNormalMap.isTexture&&(n.clearcoatNormalMap=this.clearcoatNormalMap.toJSON(e).uuid,n.clearcoatNormalScale=this.clearcoatNormalScale.toArray()),this.sheenColorMap&&this.sheenColorMap.isTexture&&(n.sheenColorMap=this.sheenColorMap.toJSON(e).uuid),this.sheenRoughnessMap&&this.sheenRoughnessMap.isTexture&&(n.sheenRoughnessMap=this.sheenRoughnessMap.toJSON(e).uuid),this.dispersion!==void 0&&(n.dispersion=this.dispersion),this.iridescence!==void 0&&(n.iridescence=this.iridescence),this.iridescenceIOR!==void 0&&(n.iridescenceIOR=this.iridescenceIOR),this.iridescenceThicknessRange!==void 0&&(n.iridescenceThicknessRange=this.iridescenceThicknessRange),this.iridescenceMap&&this.iridescenceMap.isTexture&&(n.iridescenceMap=this.iridescenceMap.toJSON(e).uuid),this.iridescenceThicknessMap&&this.iridescenceThicknessMap.isTexture&&(n.iridescenceThicknessMap=this.iridescenceThicknessMap.toJSON(e).uuid),this.anisotropy!==void 0&&(n.anisotropy=this.anisotropy),this.anisotropyRotation!==void 0&&(n.anisotropyRotation=this.anisotropyRotation),this.anisotropyMap&&this.anisotropyMap.isTexture&&(n.anisotropyMap=this.anisotropyMap.toJSON(e).uuid),this.map&&this.map.isTexture&&(n.map=this.map.toJSON(e).uuid),this.matcap&&this.matcap.isTexture&&(n.matcap=this.matcap.toJSON(e).uuid),this.alphaMap&&this.alphaMap.isTexture&&(n.alphaMap=this.alphaMap.toJSON(e).uuid),this.lightMap&&this.lightMap.isTexture&&(n.lightMap=this.lightMap.toJSON(e).uuid,n.lightMapIntensity=this.lightMapIntensity),this.aoMap&&this.aoMap.isTexture&&(n.aoMap=this.aoMap.toJSON(e).uuid,n.aoMapIntensity=this.aoMapIntensity),this.bumpMap&&this.bumpMap.isTexture&&(n.bumpMap=this.bumpMap.toJSON(e).uuid,n.bumpScale=this.bumpScale),this.normalMap&&this.normalMap.isTexture&&(n.normalMap=this.normalMap.toJSON(e).uuid,n.normalMapType=this.normalMapType,n.normalScale=this.normalScale.toArray()),this.displacementMap&&this.displacementMap.isTexture&&(n.displacementMap=this.displacementMap.toJSON(e).uuid,n.displacementScale=this.displacementScale,n.displacementBias=this.displacementBias),this.roughnessMap&&this.roughnessMap.isTexture&&(n.roughnessMap=this.roughnessMap.toJSON(e).uuid),this.metalnessMap&&this.metalnessMap.isTexture&&(n.metalnessMap=this.metalnessMap.toJSON(e).uuid),this.emissiveMap&&this.emissiveMap.isTexture&&(n.emissiveMap=this.emissiveMap.toJSON(e).uuid),this.specularMap&&this.specularMap.isTexture&&(n.specularMap=this.specularMap.toJSON(e).uuid),this.specularIntensityMap&&this.specularIntensityMap.isTexture&&(n.specularIntensityMap=this.specularIntensityMap.toJSON(e).uuid),this.specularColorMap&&this.specularColorMap.isTexture&&(n.specularColorMap=this.specularColorMap.toJSON(e).uuid),this.envMap&&this.envMap.isTexture&&(n.envMap=this.envMap.toJSON(e).uuid,this.combine!==void 0&&(n.combine=this.combine)),this.envMapRotation!==void 0&&(n.envMapRotation=this.envMapRotation.toArray()),this.envMapIntensity!==void 0&&(n.envMapIntensity=this.envMapIntensity),this.reflectivity!==void 0&&(n.reflectivity=this.reflectivity),this.refractionRatio!==void 0&&(n.refractionRatio=this.refractionRatio),this.gradientMap&&this.gradientMap.isTexture&&(n.gradientMap=this.gradientMap.toJSON(e).uuid),this.transmission!==void 0&&(n.transmission=this.transmission),this.transmissionMap&&this.transmissionMap.isTexture&&(n.transmissionMap=this.transmissionMap.toJSON(e).uuid),this.thickness!==void 0&&(n.thickness=this.thickness),this.thicknessMap&&this.thicknessMap.isTexture&&(n.thicknessMap=this.thicknessMap.toJSON(e).uuid),this.attenuationDistance!==void 0&&this.attenuationDistance!==1/0&&(n.attenuationDistance=this.attenuationDistance),this.attenuationColor!==void 0&&(n.attenuationColor=this.attenuationColor.getHex()),this.size!==void 0&&(n.size=this.size),this.shadowSide!==null&&(n.shadowSide=this.shadowSide),this.sizeAttenuation!==void 0&&(n.sizeAttenuation=this.sizeAttenuation),this.blending!==ws&&(n.blending=this.blending),this.side!==ai&&(n.side=this.side),this.vertexColors===!0&&(n.vertexColors=!0),this.opacity<1&&(n.opacity=this.opacity),this.transparent===!0&&(n.transparent=!0),this.blendSrc!==Ou&&(n.blendSrc=this.blendSrc),this.blendDst!==Nu&&(n.blendDst=this.blendDst),this.blendEquation!==Ni&&(n.blendEquation=this.blendEquation),this.blendSrcAlpha!==null&&(n.blendSrcAlpha=this.blendSrcAlpha),this.blendDstAlpha!==null&&(n.blendDstAlpha=this.blendDstAlpha),this.blendEquationAlpha!==null&&(n.blendEquationAlpha=this.blendEquationAlpha),this.blendColor&&this.blendColor.isColor&&(n.blendColor=this.blendColor.getHex()),this.blendAlpha!==0&&(n.blendAlpha=this.blendAlpha),this.depthFunc!==Rs&&(n.depthFunc=this.depthFunc),this.depthTest===!1&&(n.depthTest=this.depthTest),this.depthWrite===!1&&(n.depthWrite=this.depthWrite),this.colorWrite===!1&&(n.colorWrite=this.colorWrite),this.stencilWriteMask!==255&&(n.stencilWriteMask=this.stencilWriteMask),this.stencilFunc!==Th&&(n.stencilFunc=this.stencilFunc),this.stencilRef!==0&&(n.stencilRef=this.stencilRef),this.stencilFuncMask!==255&&(n.stencilFuncMask=this.stencilFuncMask),this.stencilFail!==Ts&&(n.stencilFail=this.stencilFail),this.stencilZFail!==Ts&&(n.stencilZFail=this.stencilZFail),this.stencilZPass!==Ts&&(n.stencilZPass=this.stencilZPass),this.stencilWrite===!0&&(n.stencilWrite=this.stencilWrite),this.rotation!==void 0&&this.rotation!==0&&(n.rotation=this.rotation),this.polygonOffset===!0&&(n.polygonOffset=!0),this.polygonOffsetFactor!==0&&(n.polygonOffsetFactor=this.polygonOffsetFactor),this.polygonOffsetUnits!==0&&(n.polygonOffsetUnits=this.polygonOffsetUnits),this.linewidth!==void 0&&this.linewidth!==1&&(n.linewidth=this.linewidth),this.dashSize!==void 0&&(n.dashSize=this.dashSize),this.gapSize!==void 0&&(n.gapSize=this.gapSize),this.scale!==void 0&&(n.scale=this.scale),this.dithering===!0&&(n.dithering=!0),this.alphaTest>0&&(n.alphaTest=this.alphaTest),this.alphaHash===!0&&(n.alphaHash=!0),this.alphaToCoverage===!0&&(n.alphaToCoverage=!0),this.premultipliedAlpha===!0&&(n.premultipliedAlpha=!0),this.forceSinglePass===!0&&(n.forceSinglePass=!0),this.allowOverride===!1&&(n.allowOverride=!1),this.wireframe===!0&&(n.wireframe=!0),this.wireframeLinewidth>1&&(n.wireframeLinewidth=this.wireframeLinewidth),this.wireframeLinecap!=="round"&&(n.wireframeLinecap=this.wireframeLinecap),this.wireframeLinejoin!=="round"&&(n.wireframeLinejoin=this.wireframeLinejoin),this.flatShading===!0&&(n.flatShading=!0),this.visible===!1&&(n.visible=!1),this.toneMapped===!1&&(n.toneMapped=!1),this.fog===!1&&(n.fog=!1),Object.keys(this.userData).length>0&&(n.userData=this.userData);function i(s){let r=[];for(let o in s){let l=s[o];delete l.metadata,r.push(l)}return r}if(a){let s=i(e.textures),r=i(e.images);s.length>0&&(n.textures=s),r.length>0&&(n.images=r)}return n}fromJSON(e,a){if(e.uuid!==void 0&&(this.uuid=e.uuid),e.name!==void 0&&(this.name=e.name),e.color!==void 0&&this.color!==void 0&&this.color.setHex(e.color),e.roughness!==void 0&&(this.roughness=e.roughness),e.metalness!==void 0&&(this.metalness=e.metalness),e.sheen!==void 0&&(this.sheen=e.sheen),e.sheenColor!==void 0&&(this.sheenColor=new Je().setHex(e.sheenColor)),e.sheenRoughness!==void 0&&(this.sheenRoughness=e.sheenRoughness),e.emissive!==void 0&&this.emissive!==void 0&&this.emissive.setHex(e.emissive),e.specular!==void 0&&this.specular!==void 0&&this.specular.setHex(e.specular),e.specularIntensity!==void 0&&(this.specularIntensity=e.specularIntensity),e.specularColor!==void 0&&this.specularColor!==void 0&&this.specularColor.setHex(e.specularColor),e.shininess!==void 0&&(this.shininess=e.shininess),e.clearcoat!==void 0&&(this.clearcoat=e.clearcoat),e.clearcoatRoughness!==void 0&&(this.clearcoatRoughness=e.clearcoatRoughness),e.dispersion!==void 0&&(this.dispersion=e.dispersion),e.iridescence!==void 0&&(this.iridescence=e.iridescence),e.iridescenceIOR!==void 0&&(this.iridescenceIOR=e.iridescenceIOR),e.iridescenceThicknessRange!==void 0&&(this.iridescenceThicknessRange=e.iridescenceThicknessRange),e.transmission!==void 0&&(this.transmission=e.transmission),e.thickness!==void 0&&(this.thickness=e.thickness),e.attenuationDistance!==void 0&&(this.attenuationDistance=e.attenuationDistance),e.attenuationColor!==void 0&&this.attenuationColor!==void 0&&this.attenuationColor.setHex(e.attenuationColor),e.anisotropy!==void 0&&(this.anisotropy=e.anisotropy),e.anisotropyRotation!==void 0&&(this.anisotropyRotation=e.anisotropyRotation),e.fog!==void 0&&(this.fog=e.fog),e.flatShading!==void 0&&(this.flatShading=e.flatShading),e.blending!==void 0&&(this.blending=e.blending),e.combine!==void 0&&(this.combine=e.combine),e.side!==void 0&&(this.side=e.side),e.shadowSide!==void 0&&(this.shadowSide=e.shadowSide),e.opacity!==void 0&&(this.opacity=e.opacity),e.transparent!==void 0&&(this.transparent=e.transparent),e.alphaTest!==void 0&&(this.alphaTest=e.alphaTest),e.alphaHash!==void 0&&(this.alphaHash=e.alphaHash),e.depthFunc!==void 0&&(this.depthFunc=e.depthFunc),e.depthTest!==void 0&&(this.depthTest=e.depthTest),e.depthWrite!==void 0&&(this.depthWrite=e.depthWrite),e.colorWrite!==void 0&&(this.colorWrite=e.colorWrite),e.blendSrc!==void 0&&(this.blendSrc=e.blendSrc),e.blendDst!==void 0&&(this.blendDst=e.blendDst),e.blendEquation!==void 0&&(this.blendEquation=e.blendEquation),e.blendSrcAlpha!==void 0&&(this.blendSrcAlpha=e.blendSrcAlpha),e.blendDstAlpha!==void 0&&(this.blendDstAlpha=e.blendDstAlpha),e.blendEquationAlpha!==void 0&&(this.blendEquationAlpha=e.blendEquationAlpha),e.blendColor!==void 0&&this.blendColor!==void 0&&this.blendColor.setHex(e.blendColor),e.blendAlpha!==void 0&&(this.blendAlpha=e.blendAlpha),e.stencilWriteMask!==void 0&&(this.stencilWriteMask=e.stencilWriteMask),e.stencilFunc!==void 0&&(this.stencilFunc=e.stencilFunc),e.stencilRef!==void 0&&(this.stencilRef=e.stencilRef),e.stencilFuncMask!==void 0&&(this.stencilFuncMask=e.stencilFuncMask),e.stencilFail!==void 0&&(this.stencilFail=e.stencilFail),e.stencilZFail!==void 0&&(this.stencilZFail=e.stencilZFail),e.stencilZPass!==void 0&&(this.stencilZPass=e.stencilZPass),e.stencilWrite!==void 0&&(this.stencilWrite=e.stencilWrite),e.wireframe!==void 0&&(this.wireframe=e.wireframe),e.wireframeLinewidth!==void 0&&(this.wireframeLinewidth=e.wireframeLinewidth),e.wireframeLinecap!==void 0&&(this.wireframeLinecap=e.wireframeLinecap),e.wireframeLinejoin!==void 0&&(this.wireframeLinejoin=e.wireframeLinejoin),e.rotation!==void 0&&(this.rotation=e.rotation),e.linewidth!==void 0&&(this.linewidth=e.linewidth),e.dashSize!==void 0&&(this.dashSize=e.dashSize),e.gapSize!==void 0&&(this.gapSize=e.gapSize),e.scale!==void 0&&(this.scale=e.scale),e.polygonOffset!==void 0&&(this.polygonOffset=e.polygonOffset),e.polygonOffsetFactor!==void 0&&(this.polygonOffsetFactor=e.polygonOffsetFactor),e.polygonOffsetUnits!==void 0&&(this.polygonOffsetUnits=e.polygonOffsetUnits),e.dithering!==void 0&&(this.dithering=e.dithering),e.alphaToCoverage!==void 0&&(this.alphaToCoverage=e.alphaToCoverage),e.premultipliedAlpha!==void 0&&(this.premultipliedAlpha=e.premultipliedAlpha),e.forceSinglePass!==void 0&&(this.forceSinglePass=e.forceSinglePass),e.allowOverride!==void 0&&(this.allowOverride=e.allowOverride),e.visible!==void 0&&(this.visible=e.visible),e.toneMapped!==void 0&&(this.toneMapped=e.toneMapped),e.userData!==void 0&&(this.userData=e.userData),e.vertexColors!==void 0&&(typeof e.vertexColors=="number"?this.vertexColors=e.vertexColors>0:this.vertexColors=e.vertexColors),e.size!==void 0&&(this.size=e.size),e.sizeAttenuation!==void 0&&(this.sizeAttenuation=e.sizeAttenuation),e.map!==void 0&&(this.map=a[e.map]||null),e.matcap!==void 0&&(this.matcap=a[e.matcap]||null),e.alphaMap!==void 0&&(this.alphaMap=a[e.alphaMap]||null),e.bumpMap!==void 0&&(this.bumpMap=a[e.bumpMap]||null),e.bumpScale!==void 0&&(this.bumpScale=e.bumpScale),e.normalMap!==void 0&&(this.normalMap=a[e.normalMap]||null),e.normalMapType!==void 0&&(this.normalMapType=e.normalMapType),e.normalScale!==void 0){let n=e.normalScale;Array.isArray(n)===!1&&(n=[n,n]),this.normalScale=new qe().fromArray(n)}return e.displacementMap!==void 0&&(this.displacementMap=a[e.displacementMap]||null),e.displacementScale!==void 0&&(this.displacementScale=e.displacementScale),e.displacementBias!==void 0&&(this.displacementBias=e.displacementBias),e.roughnessMap!==void 0&&(this.roughnessMap=a[e.roughnessMap]||null),e.metalnessMap!==void 0&&(this.metalnessMap=a[e.metalnessMap]||null),e.emissiveMap!==void 0&&(this.emissiveMap=a[e.emissiveMap]||null),e.emissiveIntensity!==void 0&&(this.emissiveIntensity=e.emissiveIntensity),e.specularMap!==void 0&&(this.specularMap=a[e.specularMap]||null),e.specularIntensityMap!==void 0&&(this.specularIntensityMap=a[e.specularIntensityMap]||null),e.specularColorMap!==void 0&&(this.specularColorMap=a[e.specularColorMap]||null),e.envMap!==void 0&&(this.envMap=a[e.envMap]||null),e.envMapRotation!==void 0&&this.envMapRotation.fromArray(e.envMapRotation),e.envMapIntensity!==void 0&&(this.envMapIntensity=e.envMapIntensity),e.reflectivity!==void 0&&(this.reflectivity=e.reflectivity),e.refractionRatio!==void 0&&(this.refractionRatio=e.refractionRatio),e.lightMap!==void 0&&(this.lightMap=a[e.lightMap]||null),e.lightMapIntensity!==void 0&&(this.lightMapIntensity=e.lightMapIntensity),e.aoMap!==void 0&&(this.aoMap=a[e.aoMap]||null),e.aoMapIntensity!==void 0&&(this.aoMapIntensity=e.aoMapIntensity),e.gradientMap!==void 0&&(this.gradientMap=a[e.gradientMap]||null),e.clearcoatMap!==void 0&&(this.clearcoatMap=a[e.clearcoatMap]||null),e.clearcoatRoughnessMap!==void 0&&(this.clearcoatRoughnessMap=a[e.clearcoatRoughnessMap]||null),e.clearcoatNormalMap!==void 0&&(this.clearcoatNormalMap=a[e.clearcoatNormalMap]||null),e.clearcoatNormalScale!==void 0&&(this.clearcoatNormalScale=new qe().fromArray(e.clearcoatNormalScale)),e.iridescenceMap!==void 0&&(this.iridescenceMap=a[e.iridescenceMap]||null),e.iridescenceThicknessMap!==void 0&&(this.iridescenceThicknessMap=a[e.iridescenceThicknessMap]||null),e.transmissionMap!==void 0&&(this.transmissionMap=a[e.transmissionMap]||null),e.thicknessMap!==void 0&&(this.thicknessMap=a[e.thicknessMap]||null),e.anisotropyMap!==void 0&&(this.anisotropyMap=a[e.anisotropyMap]||null),e.sheenColorMap!==void 0&&(this.sheenColorMap=a[e.sheenColorMap]||null),e.sheenRoughnessMap!==void 0&&(this.sheenRoughnessMap=a[e.sheenRoughnessMap]||null),this}clone(){return new this.constructor().copy(this)}copy(e){this.name=e.name,this.blending=e.blending,this.side=e.side,this.vertexColors=e.vertexColors,this.opacity=e.opacity,this.transparent=e.transparent,this.blendSrc=e.blendSrc,this.blendDst=e.blendDst,this.blendEquation=e.blendEquation,this.blendSrcAlpha=e.blendSrcAlpha,this.blendDstAlpha=e.blendDstAlpha,this.blendEquationAlpha=e.blendEquationAlpha,this.blendColor.copy(e.blendColor),this.blendAlpha=e.blendAlpha,this.depthFunc=e.depthFunc,this.depthTest=e.depthTest,this.depthWrite=e.depthWrite,this.stencilWriteMask=e.stencilWriteMask,this.stencilFunc=e.stencilFunc,this.stencilRef=e.stencilRef,this.stencilFuncMask=e.stencilFuncMask,this.stencilFail=e.stencilFail,this.stencilZFail=e.stencilZFail,this.stencilZPass=e.stencilZPass,this.stencilWrite=e.stencilWrite;let a=e.clippingPlanes,n=null;if(a!==null){let i=a.length;n=new Array(i);for(let s=0;s!==i;++s)n[s]=a[s].clone()}return this.clippingPlanes=n,this.clipIntersection=e.clipIntersection,this.clipShadows=e.clipShadows,this.shadowSide=e.shadowSide,this.colorWrite=e.colorWrite,this.precision=e.precision,this.polygonOffset=e.polygonOffset,this.polygonOffsetFactor=e.polygonOffsetFactor,this.polygonOffsetUnits=e.polygonOffsetUnits,this.dithering=e.dithering,this.alphaTest=e.alphaTest,this.alphaHash=e.alphaHash,this.alphaToCoverage=e.alphaToCoverage,this.premultipliedAlpha=e.premultipliedAlpha,this.forceSinglePass=e.forceSinglePass,this.allowOverride=e.allowOverride,this.visible=e.visible,this.toneMapped=e.toneMapped,this.userData=JSON.parse(JSON.stringify(e.userData)),this}dispose(){this.dispatchEvent({type:"dispose"})}set needsUpdate(e){e===!0&&this.version++}};var ei=new F,vh=new F,Mu=new F,Ui=new F,yh=new F,bu=new F,_h=new F,ju=class{constructor(e=new F,a=new F(0,0,-1)){this.origin=e,this.direction=a}set(e,a){return this.origin.copy(e),this.direction.copy(a),this}copy(e){return this.origin.copy(e.origin),this.direction.copy(e.direction),this}at(e,a){return a.copy(this.origin).addScaledVector(this.direction,e)}lookAt(e){return this.direction.copy(e).sub(this.origin).normalize(),this}recast(e){return this.origin.copy(this.at(e,ei)),this}closestPointToPoint(e,a){a.subVectors(e,this.origin);let n=a.dot(this.direction);return n<0?a.copy(this.origin):a.copy(this.origin).addScaledVector(this.direction,n)}distanceToPoint(e){return Math.sqrt(this.distanceSqToPoint(e))}distanceSqToPoint(e){let a=ei.subVectors(e,this.origin).dot(this.direction);return a<0?this.origin.distanceToSquared(e):(ei.copy(this.origin).addScaledVector(this.direction,a),ei.distanceToSquared(e))}distanceSqToSegment(e,a,n,i){vh.copy(e).add(a).multiplyScalar(.5),Mu.copy(a).sub(e).normalize(),Ui.copy(this.origin).sub(vh);let s=e.distanceTo(a)*.5,r=-this.direction.dot(Mu),o=Ui.dot(this.direction),l=-Ui.dot(Mu),u=Ui.lengthSq(),d=Math.abs(1-r*r),p,c,h,v;if(d>0)if(p=r*l-o,c=r*o-l,v=s*d,p>=0)if(c>=-v)if(c<=v){let b=1/d;p*=b,c*=b,h=p*(p+r*c+2*o)+c*(r*p+c+2*l)+u}else c=s,p=Math.max(0,-(r*c+o)),h=-p*p+c*(c+2*l)+u;else c=-s,p=Math.max(0,-(r*c+o)),h=-p*p+c*(c+2*l)+u;else c<=-v?(p=Math.max(0,-(-r*s+o)),c=p>0?-s:Math.min(Math.max(-s,-l),s),h=-p*p+c*(c+2*l)+u):c<=v?(p=0,c=Math.min(Math.max(-s,-l),s),h=c*(c+2*l)+u):(p=Math.max(0,-(r*s+o)),c=p>0?s:Math.min(Math.max(-s,-l),s),h=-p*p+c*(c+2*l)+u);else c=r>0?-s:s,p=Math.max(0,-(r*c+o)),h=-p*p+c*(c+2*l)+u;return n&&n.copy(this.origin).addScaledVector(this.direction,p),i&&i.copy(vh).addScaledVector(Mu,c),h}intersectSphere(e,a){ei.subVectors(e.center,this.origin);let n=ei.dot(this.direction),i=ei.dot(ei)-n*n,s=e.radius*e.radius;if(i>s)return null;let r=Math.sqrt(s-i),o=n-r,l=n+r;return l<0?null:o<0?this.at(l,a):this.at(o,a)}intersectsSphere(e){return e.radius<0?!1:this.distanceSqToPoint(e.center)<=e.radius*e.radius}distanceToPlane(e){let a=e.normal.dot(this.direction);if(a===0)return e.distanceToPoint(this.origin)===0?0:null;let n=-(this.origin.dot(e.normal)+e.constant)/a;return n>=0?n:null}intersectPlane(e,a){let n=this.distanceToPlane(e);return n===null?null:this.at(n,a)}intersectsPlane(e){let a=e.distanceToPoint(this.origin);return a===0||e.normal.dot(this.direction)*a<0}intersectBox(e,a){let n,i,s,r,o,l,u=1/this.direction.x,d=1/this.direction.y,p=1/this.direction.z,c=this.origin;return u>=0?(n=(e.min.x-c.x)*u,i=(e.max.x-c.x)*u):(n=(e.max.x-c.x)*u,i=(e.min.x-c.x)*u),d>=0?(s=(e.min.y-c.y)*d,r=(e.max.y-c.y)*d):(s=(e.max.y-c.y)*d,r=(e.min.y-c.y)*d),n>r||s>i||((s>n||isNaN(n))&&(n=s),(r<i||isNaN(i))&&(i=r),p>=0?(o=(e.min.z-c.z)*p,l=(e.max.z-c.z)*p):(o=(e.max.z-c.z)*p,l=(e.min.z-c.z)*p),n>l||o>i)||((o>n||n!==n)&&(n=o),(l<i||i!==i)&&(i=l),i<0)?null:this.at(n>=0?n:i,a)}intersectsBox(e){return this.intersectBox(e,ei)!==null}intersectTriangle(e,a,n,i,s){yh.subVectors(a,e),bu.subVectors(n,e),_h.crossVectors(yh,bu);let r=this.direction.dot(_h),o;if(r>0){if(i)return null;o=1}else if(r<0)o=-1,r=-r;else return null;Ui.subVectors(this.origin,e);let l=o*this.direction.dot(bu.crossVectors(Ui,bu));if(l<0)return null;let u=o*this.direction.dot(yh.cross(Ui));if(u<0||l+u>r)return null;let d=-o*Ui.dot(_h);return d<0?null:this.at(d/r,s)}applyMatrix4(e){return this.origin.applyMatrix4(e),this.direction.transformDirection(e),this}equals(e){return e.origin.equals(this.origin)&&e.direction.equals(this.direction)}clone(){return new this.constructor().copy(this)}},Ho=class extends Ds{constructor(e){super(),this.isMeshBasicMaterial=!0,this.type="MeshBasicMaterial",this.color=new Je(16777215),this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.specularMap=null,this.alphaMap=null,this.envMap=null,this.envMapRotation=new Fi,this.combine=Bh,this.reflectivity=1,this.refractionRatio=.98,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.lightMap=e.lightMap,this.lightMapIntensity=e.lightMapIntensity,this.aoMap=e.aoMap,this.aoMapIntensity=e.aoMapIntensity,this.specularMap=e.specularMap,this.alphaMap=e.alphaMap,this.envMap=e.envMap,this.envMapRotation.copy(e.envMapRotation),this.combine=e.combine,this.reflectivity=e.reflectivity,this.refractionRatio=e.refractionRatio,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.wireframeLinecap=e.wireframeLinecap,this.wireframeLinejoin=e.wireframeLinejoin,this.fog=e.fog,this}},Fx=new Ot,Ls=new ju,Cu=new Cr,zx=new F,Lu=new F,Au=new F,Tu=new F,Sh=new F,Iu=new F,kx=new F,Eu=new F,La=class extends en{constructor(e=new Bn,a=new Ho){super(),this.isMesh=!0,this.type="Mesh",this.geometry=e,this.material=a,this.morphTargetDictionary=void 0,this.morphTargetInfluences=void 0,this.count=1,this.updateMorphTargets()}copy(e,a){return super.copy(e,a),e.morphTargetInfluences!==void 0&&(this.morphTargetInfluences=e.morphTargetInfluences.slice()),e.morphTargetDictionary!==void 0&&(this.morphTargetDictionary=Object.assign({},e.morphTargetDictionary)),this.material=Array.isArray(e.material)?e.material.slice():e.material,this.geometry=e.geometry,this}updateMorphTargets(){let a=this.geometry.morphAttributes,n=Object.keys(a);if(n.length>0){let i=a[n[0]];if(i!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let s=0,r=i.length;s<r;s++){let o=i[s].name||String(s);this.morphTargetInfluences.push(0),this.morphTargetDictionary[o]=s}}}}getVertexPosition(e,a){let n=this.geometry,i=n.attributes.position,s=n.morphAttributes.position,r=n.morphTargetsRelative;a.fromBufferAttribute(i,e);let o=this.morphTargetInfluences;if(s&&o){Iu.set(0,0,0);for(let l=0,u=s.length;l<u;l++){let d=o[l],p=s[l];d!==0&&(Sh.fromBufferAttribute(p,e),r?Iu.addScaledVector(Sh,d):Iu.addScaledVector(Sh.sub(a),d))}a.add(Iu)}return a}raycast(e,a){let n=this.geometry,i=this.material,s=this.matrixWorld;i!==void 0&&(n.boundingSphere===null&&n.computeBoundingSphere(),Cu.copy(n.boundingSphere),Cu.applyMatrix4(s),Ls.copy(e.ray).recast(e.near),!(Cu.containsPoint(Ls.origin)===!1&&(Ls.intersectSphere(Cu,zx)===null||Ls.origin.distanceToSquared(zx)>(e.far-e.near)**2))&&(Fx.copy(s).invert(),Ls.copy(e.ray).applyMatrix4(Fx),!(n.boundingBox!==null&&Ls.intersectsBox(n.boundingBox)===!1)&&this._computeIntersections(e,a,Ls)))}_computeIntersections(e,a,n){let i,s=this.geometry,r=this.material,o=s.index,l=s.attributes.position,u=s.attributes.uv,d=s.attributes.uv1,p=s.attributes.normal,c=s.groups,h=s.drawRange;if(o!==null)if(Array.isArray(r))for(let v=0,b=c.length;v<b;v++){let m=c[v],f=r[m.materialIndex],x=Math.max(m.start,h.start),S=Math.min(o.count,Math.min(m.start+m.count,h.start+h.count));for(let _=x,L=S;_<L;_+=3){let C=o.getX(_),T=o.getX(_+1),y=o.getX(_+2);i=wu(this,f,e,n,u,d,p,C,T,y),i&&(i.faceIndex=Math.floor(_/3),i.face.materialIndex=m.materialIndex,a.push(i))}}else{let v=Math.max(0,h.start),b=Math.min(o.count,h.start+h.count);for(let m=v,f=b;m<f;m+=3){let x=o.getX(m),S=o.getX(m+1),_=o.getX(m+2);i=wu(this,r,e,n,u,d,p,x,S,_),i&&(i.faceIndex=Math.floor(m/3),a.push(i))}}else if(l!==void 0)if(Array.isArray(r))for(let v=0,b=c.length;v<b;v++){let m=c[v],f=r[m.materialIndex],x=Math.max(m.start,h.start),S=Math.min(l.count,Math.min(m.start+m.count,h.start+h.count));for(let _=x,L=S;_<L;_+=3){let C=_,T=_+1,y=_+2;i=wu(this,f,e,n,u,d,p,C,T,y),i&&(i.faceIndex=Math.floor(_/3),i.face.materialIndex=m.materialIndex,a.push(i))}}else{let v=Math.max(0,h.start),b=Math.min(l.count,h.start+h.count);for(let m=v,f=b;m<f;m+=3){let x=m,S=m+1,_=m+2;i=wu(this,r,e,n,u,d,p,x,S,_),i&&(i.faceIndex=Math.floor(m/3),a.push(i))}}}};function qb(t,e,a,n,i,s,r,o){let l;if(e.side===va?l=n.intersectTriangle(r,s,i,!0,o):l=n.intersectTriangle(i,s,r,e.side===ai,o),l===null)return null;Eu.copy(o),Eu.applyMatrix4(t.matrixWorld);let u=a.ray.origin.distanceTo(Eu);return u<a.near||u>a.far?null:{distance:u,point:Eu.clone(),object:t}}function wu(t,e,a,n,i,s,r,o,l,u){t.getVertexPosition(o,Lu),t.getVertexPosition(l,Au),t.getVertexPosition(u,Tu);let d=qb(t,e,a,n,Lu,Au,Tu,kx);if(d){let p=new F;Oi.getBarycoord(kx,Lu,Au,Tu,p),i&&(d.uv=Oi.getInterpolatedAttribute(i,o,l,u,p,new qe)),s&&(d.uv1=Oi.getInterpolatedAttribute(s,o,l,u,p,new qe)),r&&(d.normal=Oi.getInterpolatedAttribute(r,o,l,u,p,new F),d.normal.dot(n.direction)>0&&d.normal.multiplyScalar(-1));let c={a:o,b:l,c:u,normal:new F,materialIndex:0};Oi.getNormal(Lu,Au,Tu,c.normal),d.face=c,d.barycoord=p}return d}var $u=class extends Ca{constructor(e=null,a=1,n=1,i,s,r,o,l,u=$t,d=$t,p,c){super(null,r,o,l,u,d,i,s,p,c),this.isDataTexture=!0,this.image={data:e,width:a,height:n},this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}};var Mh=new F,Wb=new F,Xb=new De,wn=class{constructor(e=new F(1,0,0),a=0){this.isPlane=!0,this.normal=e,this.constant=a}set(e,a){return this.normal.copy(e),this.constant=a,this}setComponents(e,a,n,i){return this.normal.set(e,a,n),this.constant=i,this}setFromNormalAndCoplanarPoint(e,a){return this.normal.copy(e),this.constant=-a.dot(this.normal),this}setFromCoplanarPoints(e,a,n){let i=Mh.subVectors(n,a).cross(Wb.subVectors(e,a)).normalize();return this.setFromNormalAndCoplanarPoint(i,e),this}copy(e){return this.normal.copy(e.normal),this.constant=e.constant,this}normalize(){let e=1/this.normal.length();return this.normal.multiplyScalar(e),this.constant*=e,this}negate(){return this.constant*=-1,this.normal.negate(),this}distanceToPoint(e){return this.normal.dot(e)+this.constant}distanceToSphere(e){return this.distanceToPoint(e.center)-e.radius}projectPoint(e,a){return a.copy(e).addScaledVector(this.normal,-this.distanceToPoint(e))}intersectLine(e,a,n=!0){let i=e.delta(Mh),s=this.normal.dot(i);if(s===0)return this.distanceToPoint(e.start)===0?a.copy(e.start):null;let r=-(e.start.dot(this.normal)+this.constant)/s;return n===!0&&(r<0||r>1)?null:a.copy(e.start).addScaledVector(i,r)}intersectsLine(e){let a=this.distanceToPoint(e.start),n=this.distanceToPoint(e.end);return a<0&&n>0||n<0&&a>0}intersectsBox(e){return e.intersectsPlane(this)}intersectsSphere(e){return e.intersectsPlane(this)}coplanarPoint(e){return e.copy(this.normal).multiplyScalar(-this.constant)}applyMatrix4(e,a){let n=a||Xb.getNormalMatrix(e),i=this.coplanarPoint(Mh).applyMatrix4(e),s=this.normal.applyMatrix3(n).normalize();return this.constant=-i.dot(s),this}translate(e){return this.constant-=e.dot(this.normal),this}equals(e){return e.normal.equals(this.normal)&&e.constant===this.constant}clone(){return new this.constructor().copy(this)}},As=new Cr,Yb=new qe(.5,.5),Ru=new F,Vo=class{constructor(e=new wn,a=new wn,n=new wn,i=new wn,s=new wn,r=new wn){this.planes=[e,a,n,i,s,r]}set(e,a,n,i,s,r){let o=this.planes;return o[0].copy(e),o[1].copy(a),o[2].copy(n),o[3].copy(i),o[4].copy(s),o[5].copy(r),this}copy(e){let a=this.planes;for(let n=0;n<6;n++)a[n].copy(e.planes[n]);return this}setFromProjectionMatrix(e,a=xn,n=!1){let i=this.planes,s=e.elements,r=s[0],o=s[1],l=s[2],u=s[3],d=s[4],p=s[5],c=s[6],h=s[7],v=s[8],b=s[9],m=s[10],f=s[11],x=s[12],S=s[13],_=s[14],L=s[15];if(i[0].setComponents(u-r,h-d,f-v,L-x).normalize(),i[1].setComponents(u+r,h+d,f+v,L+x).normalize(),i[2].setComponents(u+o,h+p,f+b,L+S).normalize(),i[3].setComponents(u-o,h-p,f-b,L-S).normalize(),n)i[4].setComponents(l,c,m,_).normalize(),i[5].setComponents(u-l,h-c,f-m,L-_).normalize();else if(i[4].setComponents(u-l,h-c,f-m,L-_).normalize(),a===xn)i[5].setComponents(u+l,h+c,f+m,L+_).normalize();else if(a===Uo)i[5].setComponents(l,c,m,_).normalize();else throw new Error("THREE.Frustum.setFromProjectionMatrix(): Invalid coordinate system: "+a);return this}intersectsObject(e){if(e.boundingSphere!==void 0)e.boundingSphere===null&&e.computeBoundingSphere(),As.copy(e.boundingSphere).applyMatrix4(e.matrixWorld);else{let a=e.geometry;a.boundingSphere===null&&a.computeBoundingSphere(),As.copy(a.boundingSphere).applyMatrix4(e.matrixWorld)}return this.intersectsSphere(As)}intersectsSprite(e){As.center.set(0,0,0);let a=Yb.distanceTo(e.center);return As.radius=.7071067811865476+a,As.applyMatrix4(e.matrixWorld),this.intersectsSphere(As)}intersectsSphere(e){let a=this.planes,n=e.center,i=-e.radius;for(let s=0;s<6;s++)if(a[s].distanceToPoint(n)<i)return!1;return!0}intersectsBox(e){let a=this.planes;for(let n=0;n<6;n++){let i=a[n];if(Ru.x=i.normal.x>0?e.max.x:e.min.x,Ru.y=i.normal.y>0?e.max.y:e.min.y,Ru.z=i.normal.z>0?e.max.z:e.min.z,i.distanceToPoint(Ru)<0)return!1}return!0}containsPoint(e){let a=this.planes;for(let n=0;n<6;n++)if(a[n].distanceToPoint(e)<0)return!1;return!0}clone(){return new this.constructor().copy(this)}};var Go=class extends Ca{constructor(e=[],a=Gi,n,i,s,r,o,l,u,d){super(e,a,n,i,s,r,o,l,u,d),this.isCubeTexture=!0,this.flipY=!1}get images(){return this.image}set images(e){this.image=e}};var ni=class extends Ca{constructor(e,a,n=yn,i,s,r,o=$t,l=$t,u,d=Dn,p=1){if(d!==Dn&&d!==Wi)throw new Error("THREE.DepthTexture: format must be either THREE.DepthFormat or THREE.DepthStencilFormat");let c={width:e,height:a,depth:p};super(c,i,s,r,o,l,d,n,u),this.isDepthTexture=!0,this.flipY=!1,this.generateMipmaps=!1,this.compareFunction=null}copy(e){return super.copy(e),this.source=new Mr(Object.assign({},e.image)),this.compareFunction=e.compareFunction,this}toJSON(e){let a=super.toJSON(e);return this.compareFunction!==null&&(a.compareFunction=this.compareFunction),a}},ec=class extends ni{constructor(e,a=yn,n=Gi,i,s,r=$t,o=$t,l,u=Dn){let d={width:e,height:e,depth:1},p=[d,d,d,d,d,d];super(e,e,a,n,i,s,r,o,l,u),this.image=p,this.isCubeDepthTexture=!0,this.isCubeTexture=!0}get images(){return this.image}set images(e){this.image=e}},qo=class extends Ca{constructor(e=null){super(),this.sourceTexture=e,this.isExternalTexture=!0}copy(e){return super.copy(e),this.sourceTexture=e.sourceTexture,this}},Lr=class t extends Bn{constructor(e=1,a=1,n=1,i=1,s=1,r=1){super(),this.type="BoxGeometry",this.parameters={width:e,height:a,depth:n,widthSegments:i,heightSegments:s,depthSegments:r};let o=this;i=Math.floor(i),s=Math.floor(s),r=Math.floor(r);let l=[],u=[],d=[],p=[],c=0,h=0;v("z","y","x",-1,-1,n,a,e,r,s,0),v("z","y","x",1,-1,n,a,-e,r,s,1),v("x","z","y",1,1,e,n,a,i,r,2),v("x","z","y",1,-1,e,n,-a,i,r,3),v("x","y","z",1,-1,e,a,n,i,s,4),v("x","y","z",-1,-1,e,a,-n,i,s,5),this.setIndex(l),this.setAttribute("position",new $a(u,3)),this.setAttribute("normal",new $a(d,3)),this.setAttribute("uv",new $a(p,2));function v(b,m,f,x,S,_,L,C,T,y,A){let E=_/T,w=L/y,B=_/2,X=L/2,K=C/2,z=T+1,W=y+1,V=0,j=0,ee=new F;for(let fe=0;fe<W;fe++){let me=fe*w-X;for(let ve=0;ve<z;ve++){let Qe=ve*E-B;ee[b]=Qe*x,ee[m]=me*S,ee[f]=K,u.push(ee.x,ee.y,ee.z),ee[b]=0,ee[m]=0,ee[f]=C>0?1:-1,d.push(ee.x,ee.y,ee.z),p.push(ve/T),p.push(1-fe/y),V+=1}}for(let fe=0;fe<y;fe++)for(let me=0;me<T;me++){let ve=c+me+z*fe,Qe=c+me+z*(fe+1),Tt=c+(me+1)+z*(fe+1),je=c+(me+1)+z*fe;l.push(ve,Qe,je),l.push(Qe,Tt,je),j+=6}o.addGroup(h,j,A),h+=j,c+=V}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new t(e.width,e.height,e.depth,e.widthSegments,e.heightSegments,e.depthSegments)}};var Ps=class t extends Bn{constructor(e=1,a=1,n=1,i=1){super(),this.type="PlaneGeometry",this.parameters={width:e,height:a,widthSegments:n,heightSegments:i};let s=e/2,r=a/2,o=Math.floor(n),l=Math.floor(i),u=o+1,d=l+1,p=e/o,c=a/l,h=[],v=[],b=[],m=[];for(let f=0;f<d;f++){let x=f*c-r;for(let S=0;S<u;S++){let _=S*p-s;v.push(_,-x,0),b.push(0,0,1),m.push(S/o),m.push(1-f/l)}}for(let f=0;f<l;f++)for(let x=0;x<o;x++){let S=x+u*f,_=x+u*(f+1),L=x+1+u*(f+1),C=x+1+u*f;h.push(S,_,C),h.push(_,L,C)}this.setIndex(h),this.setAttribute("position",new $a(v,3)),this.setAttribute("normal",new $a(b,3)),this.setAttribute("uv",new $a(m,2))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new t(e.width,e.height,e.widthSegments,e.heightSegments)}};function Bs(t){let e={};for(let a in t){e[a]={};for(let n in t[a]){let i=t[a][n];if(Hx(i))i.isRenderTargetTexture?(Ae("UniformsUtils: Textures of render targets cannot be cloned via cloneUniforms() or mergeUniforms()."),e[a][n]=null):e[a][n]=i.clone();else if(Array.isArray(i))if(Hx(i[0])){let s=[];for(let r=0,o=i.length;r<o;r++)s[r]=i[r].clone();e[a][n]=s}else e[a][n]=i.slice();else e[a][n]=i}}return e}function pa(t){let e={};for(let a=0;a<t.length;a++){let n=Bs(t[a]);for(let i in n)e[i]=n[i]}return e}function Hx(t){return t&&(t.isColor||t.isMatrix3||t.isMatrix4||t.isVector2||t.isVector3||t.isVector4||t.isTexture||t.isQuaternion)}function Zb(t){let e=[];for(let a=0;a<t.length;a++)e.push(t[a].clone());return e}function ep(t){let e=t.getRenderTarget();return e===null?t.outputColorSpace:e.isXRRenderTarget===!0?e.texture.colorSpace:Ge.workingColorSpace}var T0={clone:Bs,merge:pa},Kb=`void main() {
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`,Jb=`void main() {
	gl_FragColor = vec4( 1.0, 0.0, 0.0, 1.0 );
}`,xa=class extends Ds{constructor(e){super(),this.isShaderMaterial=!0,this.type="ShaderMaterial",this.defines={},this.uniforms={},this.uniformsGroups=[],this.vertexShader=Kb,this.fragmentShader=Jb,this.linewidth=1,this.wireframe=!1,this.wireframeLinewidth=1,this.fog=!1,this.lights=!1,this.clipping=!1,this.forceSinglePass=!0,this.extensions={clipCullDistance:!1,multiDraw:!1},this.defaultAttributeValues={color:[1,1,1],uv:[0,0],uv1:[0,0]},this.index0AttributeName=void 0,this.uniformsNeedUpdate=!1,this.glslVersion=null,e!==void 0&&this.setValues(e)}copy(e){return super.copy(e),this.fragmentShader=e.fragmentShader,this.vertexShader=e.vertexShader,this.uniforms=Bs(e.uniforms),this.uniformsGroups=Zb(e.uniformsGroups),this.defines=Object.assign({},e.defines),this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.fog=e.fog,this.lights=e.lights,this.clipping=e.clipping,this.extensions=Object.assign({},e.extensions),this.glslVersion=e.glslVersion,this.defaultAttributeValues=Object.assign({},e.defaultAttributeValues),this.index0AttributeName=e.index0AttributeName,this.uniformsNeedUpdate=e.uniformsNeedUpdate,this}toJSON(e){let a=super.toJSON(e);a.glslVersion=this.glslVersion,a.uniforms={};for(let i in this.uniforms){let r=this.uniforms[i].value;r&&r.isTexture?a.uniforms[i]={type:"t",value:r.toJSON(e).uuid}:r&&r.isColor?a.uniforms[i]={type:"c",value:r.getHex()}:r&&r.isVector2?a.uniforms[i]={type:"v2",value:r.toArray()}:r&&r.isVector3?a.uniforms[i]={type:"v3",value:r.toArray()}:r&&r.isVector4?a.uniforms[i]={type:"v4",value:r.toArray()}:r&&r.isMatrix3?a.uniforms[i]={type:"m3",value:r.toArray()}:r&&r.isMatrix4?a.uniforms[i]={type:"m4",value:r.toArray()}:a.uniforms[i]={value:r}}Object.keys(this.defines).length>0&&(a.defines=this.defines),a.vertexShader=this.vertexShader,a.fragmentShader=this.fragmentShader,a.lights=this.lights,a.clipping=this.clipping;let n={};for(let i in this.extensions)this.extensions[i]===!0&&(n[i]=!0);return Object.keys(n).length>0&&(a.extensions=n),a}fromJSON(e,a){if(super.fromJSON(e,a),e.uniforms!==void 0)for(let n in e.uniforms){let i=e.uniforms[n];switch(this.uniforms[n]={},i.type){case"t":this.uniforms[n].value=a[i.value]||null;break;case"c":this.uniforms[n].value=new Je().setHex(i.value);break;case"v2":this.uniforms[n].value=new qe().fromArray(i.value);break;case"v3":this.uniforms[n].value=new F().fromArray(i.value);break;case"v4":this.uniforms[n].value=new At().fromArray(i.value);break;case"m3":this.uniforms[n].value=new De().fromArray(i.value);break;case"m4":this.uniforms[n].value=new Ot().fromArray(i.value);break;default:this.uniforms[n].value=i.value}}if(e.defines!==void 0&&(this.defines=e.defines),e.vertexShader!==void 0&&(this.vertexShader=e.vertexShader),e.fragmentShader!==void 0&&(this.fragmentShader=e.fragmentShader),e.glslVersion!==void 0&&(this.glslVersion=e.glslVersion),e.extensions!==void 0)for(let n in e.extensions)this.extensions[n]=e.extensions[n];return e.lights!==void 0&&(this.lights=e.lights),e.clipping!==void 0&&(this.clipping=e.clipping),this}},tc=class extends xa{constructor(e){super(e),this.isRawShaderMaterial=!0,this.type="RawShaderMaterial"}};var ac=class extends Ds{constructor(e){super(),this.isMeshDepthMaterial=!0,this.type="MeshDepthMaterial",this.depthPacking=p0,this.map=null,this.alphaMap=null,this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.wireframe=!1,this.wireframeLinewidth=1,this.setValues(e)}copy(e){return super.copy(e),this.depthPacking=e.depthPacking,this.map=e.map,this.alphaMap=e.alphaMap,this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this}},nc=class extends Ds{constructor(e){super(),this.isMeshDistanceMaterial=!0,this.type="MeshDistanceMaterial",this.map=null,this.alphaMap=null,this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.setValues(e)}copy(e){return super.copy(e),this.map=e.map,this.alphaMap=e.alphaMap,this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this}};function Du(t,e){return!t||t.constructor===e?t:typeof e.BYTES_PER_ELEMENT=="number"?new e(t):Array.prototype.slice.call(t)}var ki=class{constructor(e,a,n,i){this.parameterPositions=e,this._cachedIndex=0,this.resultBuffer=i!==void 0?i:new a.constructor(n),this.sampleValues=a,this.valueSize=n,this.settings=null,this.DefaultSettings_={}}evaluate(e){let a=this.parameterPositions,n=this._cachedIndex,i=a[n],s=a[n-1];e:{t:{let r;a:{n:if(!(e<i)){for(let o=n+2;;){if(i===void 0){if(e<s)break n;return n=a.length,this._cachedIndex=n,this.copySampleValue_(n-1)}if(n===o)break;if(s=i,i=a[++n],e<i)break t}r=a.length;break a}if(!(e>=s)){let o=a[1];e<o&&(n=2,s=o);for(let l=n-2;;){if(s===void 0)return this._cachedIndex=0,this.copySampleValue_(0);if(n===l)break;if(i=s,s=a[--n-1],e>=s)break t}r=n,n=0;break a}break e}for(;n<r;){let o=n+r>>>1;e<a[o]?r=o:n=o+1}if(i=a[n],s=a[n-1],s===void 0)return this._cachedIndex=0,this.copySampleValue_(0);if(i===void 0)return n=a.length,this._cachedIndex=n,this.copySampleValue_(n-1)}this._cachedIndex=n,this.intervalChanged_(n,s,i)}return this.interpolate_(n,s,e,i)}getSettings_(){return this.settings||this.DefaultSettings_}copySampleValue_(e){let a=this.resultBuffer,n=this.sampleValues,i=this.valueSize,s=e*i;for(let r=0;r!==i;++r)a[r]=n[s+r];return a}interpolate_(){throw new Error("THREE.Interpolant: Call to abstract method.")}intervalChanged_(){}},ic=class extends ki{constructor(e,a,n,i){super(e,a,n,i),this._weightPrev=-0,this._offsetPrev=-0,this._weightNext=-0,this._offsetNext=-0,this.DefaultSettings_={endingStart:Ch,endingEnd:Ch}}intervalChanged_(e,a,n){let i=this.parameterPositions,s=e-2,r=e+1,o=i[s],l=i[r];if(o===void 0)switch(this.getSettings_().endingStart){case Lh:s=e,o=2*a-n;break;case Ah:s=i.length-2,o=a+i[s]-i[s+1];break;default:s=e,o=n}if(l===void 0)switch(this.getSettings_().endingEnd){case Lh:r=e,l=2*n-a;break;case Ah:r=1,l=n+i[1]-i[0];break;default:r=e-1,l=a}let u=(n-a)*.5,d=this.valueSize;this._weightPrev=u/(a-o),this._weightNext=u/(l-n),this._offsetPrev=s*d,this._offsetNext=r*d}interpolate_(e,a,n,i){let s=this.resultBuffer,r=this.sampleValues,o=this.valueSize,l=e*o,u=l-o,d=this._offsetPrev,p=this._offsetNext,c=this._weightPrev,h=this._weightNext,v=(n-a)/(i-a),b=v*v,m=b*v,f=-c*m+2*c*b-c*v,x=(1+c)*m+(-1.5-2*c)*b+(-.5+c)*v+1,S=(-1-h)*m+(1.5+h)*b+.5*v,_=h*m-h*b;for(let L=0;L!==o;++L)s[L]=f*r[d+L]+x*r[u+L]+S*r[l+L]+_*r[p+L];return s}},sc=class extends ki{constructor(e,a,n,i){super(e,a,n,i)}interpolate_(e,a,n,i){let s=this.resultBuffer,r=this.sampleValues,o=this.valueSize,l=e*o,u=l-o,d=(n-a)/(i-a),p=1-d;for(let c=0;c!==o;++c)s[c]=r[u+c]*p+r[l+c]*d;return s}},rc=class extends ki{constructor(e,a,n,i){super(e,a,n,i)}interpolate_(e){return this.copySampleValue_(e-1)}},oc=class extends ki{interpolate_(e,a,n,i){let s=this.resultBuffer,r=this.sampleValues,o=this.valueSize,l=e*o,u=l-o,d=this.inTangents,p=this.outTangents;if(!d||!p){let v=(n-a)/(i-a),b=1-v;for(let m=0;m!==o;++m)s[m]=r[u+m]*b+r[l+m]*v;return s}let c=o*2,h=e-1;for(let v=0;v!==o;++v){let b=r[u+v],m=r[l+v],f=h*c+v*2,x=p[f],S=p[f+1],_=e*c+v*2,L=d[_],C=d[_+1],T=(n-a)/(i-a),y,A,E,w,B;for(let X=0;X<8;X++){y=T*T,A=y*T,E=1-T,w=E*E,B=w*E;let z=B*a+3*w*T*x+3*E*y*L+A*i-n;if(Math.abs(z)<1e-10)break;let W=3*w*(x-a)+6*E*T*(L-x)+3*y*(i-L);if(Math.abs(W)<1e-10)break;T=T-z/W,T=Math.max(0,Math.min(1,T))}s[v]=B*b+3*w*T*S+3*E*y*C+A*m}return s}},za=class{constructor(e,a,n,i){if(e===void 0)throw new Error("THREE.KeyframeTrack: track name is undefined");if(a===void 0||a.length===0)throw new Error("THREE.KeyframeTrack: no keyframes in track named "+e);this.name=e,this.times=Du(a,this.TimeBufferType),this.values=Du(n,this.ValueBufferType),this.setInterpolation(i||this.DefaultInterpolation)}static toJSON(e){let a=e.constructor,n;if(a.toJSON!==this.toJSON)n=a.toJSON(e);else{n={name:e.name,times:Du(e.times,Array),values:Du(e.values,Array)};let i=e.getInterpolation();i!==e.DefaultInterpolation&&(n.interpolation=i)}return n.type=e.ValueTypeName,n}InterpolantFactoryMethodDiscrete(e){return new rc(this.times,this.values,this.getValueSize(),e)}InterpolantFactoryMethodLinear(e){return new sc(this.times,this.values,this.getValueSize(),e)}InterpolantFactoryMethodSmooth(e){return new ic(this.times,this.values,this.getValueSize(),e)}InterpolantFactoryMethodBezier(e){let a=new oc(this.times,this.values,this.getValueSize(),e);return this.settings&&(a.inTangents=this.settings.inTangents,a.outTangents=this.settings.outTangents),a}setInterpolation(e){let a;switch(e){case Ro:a=this.InterpolantFactoryMethodDiscrete;break;case Yu:a=this.InterpolantFactoryMethodLinear;break;case Bu:a=this.InterpolantFactoryMethodSmooth;break;case bh:a=this.InterpolantFactoryMethodBezier;break}if(a===void 0){let n="unsupported interpolation for "+this.ValueTypeName+" keyframe track named "+this.name;if(this.createInterpolant===void 0)if(e!==this.DefaultInterpolation)this.setInterpolation(this.DefaultInterpolation);else throw new Error(n);return Ae("KeyframeTrack:",n),this}return this.createInterpolant=a,this}getInterpolation(){switch(this.createInterpolant){case this.InterpolantFactoryMethodDiscrete:return Ro;case this.InterpolantFactoryMethodLinear:return Yu;case this.InterpolantFactoryMethodSmooth:return Bu;case this.InterpolantFactoryMethodBezier:return bh}}getValueSize(){return this.values.length/this.times.length}shift(e){if(e!==0){let a=this.times;for(let n=0,i=a.length;n!==i;++n)a[n]+=e}return this}scale(e){if(e!==1){let a=this.times;for(let n=0,i=a.length;n!==i;++n)a[n]*=e}return this}trim(e,a){let n=this.times,i=n.length,s=0,r=i-1;for(;s!==i&&n[s]<e;)++s;for(;r!==-1&&n[r]>a;)--r;if(++r,s!==0||r!==i){s>=r&&(r=Math.max(r,1),s=r-1);let o=this.getValueSize();this.times=n.slice(s,r),this.values=this.values.slice(s*o,r*o)}return this}validate(){let e=!0,a=this.getValueSize();a-Math.floor(a)!==0&&(Ee("KeyframeTrack: Invalid value size in track.",this),e=!1);let n=this.times,i=this.values,s=n.length;s===0&&(Ee("KeyframeTrack: Track is empty.",this),e=!1);let r=null;for(let o=0;o!==s;o++){let l=n[o];if(typeof l=="number"&&isNaN(l)){Ee("KeyframeTrack: Time is not a valid number.",this,o,l),e=!1;break}if(r!==null&&r>l){Ee("KeyframeTrack: Out of order keys.",this,o,l,r),e=!1;break}r=l}if(i!==void 0&&Ib(i))for(let o=0,l=i.length;o!==l;++o){let u=i[o];if(isNaN(u)){Ee("KeyframeTrack: Value is not a valid number.",this,o,u),e=!1;break}}return e}optimize(){let e=this.times.slice(),a=this.values.slice(),n=this.getValueSize(),i=this.getInterpolation()===Bu,s=e.length-1,r=1;for(let o=1;o<s;++o){let l=!1,u=e[o],d=e[o+1];if(u!==d&&(o!==1||u!==e[0]))if(i)l=!0;else{let p=o*n,c=p-n,h=p+n;for(let v=0;v!==n;++v){let b=a[p+v];if(b!==a[c+v]||b!==a[h+v]){l=!0;break}}}if(l){if(o!==r){e[r]=e[o];let p=o*n,c=r*n;for(let h=0;h!==n;++h)a[c+h]=a[p+h]}++r}}if(s>0){e[r]=e[s];for(let o=s*n,l=r*n,u=0;u!==n;++u)a[l+u]=a[o+u];++r}return r!==e.length?(this.times=e.slice(0,r),this.values=a.slice(0,r*n)):(this.times=e,this.values=a),this}clone(){let e=this.times.slice(),a=this.values.slice(),n=this.constructor,i=new n(this.name,e,a);return i.createInterpolant=this.createInterpolant,i}};za.prototype.ValueTypeName="";za.prototype.TimeBufferType=Float32Array;za.prototype.ValueBufferType=Float32Array;za.prototype.DefaultInterpolation=Yu;var Hi=class extends za{constructor(e,a,n){super(e,a,n)}};Hi.prototype.ValueTypeName="bool";Hi.prototype.ValueBufferType=Array;Hi.prototype.DefaultInterpolation=Ro;Hi.prototype.InterpolantFactoryMethodLinear=void 0;Hi.prototype.InterpolantFactoryMethodSmooth=void 0;var lc=class extends za{constructor(e,a,n,i){super(e,a,n,i)}};lc.prototype.ValueTypeName="color";var uc=class extends za{constructor(e,a,n,i){super(e,a,n,i)}};uc.prototype.ValueTypeName="number";var cc=class extends ki{constructor(e,a,n,i){super(e,a,n,i)}interpolate_(e,a,n,i){let s=this.resultBuffer,r=this.sampleValues,o=this.valueSize,l=(n-a)/(i-a),u=e*o;for(let d=u+o;u!==d;u+=4)Un.slerpFlat(s,0,r,u-o,r,u,l);return s}},Wo=class extends za{constructor(e,a,n,i){super(e,a,n,i)}InterpolantFactoryMethodLinear(e){return new cc(this.times,this.values,this.getValueSize(),e)}};Wo.prototype.ValueTypeName="quaternion";Wo.prototype.InterpolantFactoryMethodSmooth=void 0;var Vi=class extends za{constructor(e,a,n){super(e,a,n)}};Vi.prototype.ValueTypeName="string";Vi.prototype.ValueBufferType=Array;Vi.prototype.DefaultInterpolation=Ro;Vi.prototype.InterpolantFactoryMethodLinear=void 0;Vi.prototype.InterpolantFactoryMethodSmooth=void 0;var fc=class extends za{constructor(e,a,n,i){super(e,a,n,i)}};fc.prototype.ValueTypeName="vector";var dc=class{constructor(e,a,n){let i=this,s=!1,r=0,o=0,l,u=[];this.onStart=void 0,this.onLoad=e,this.onProgress=a,this.onError=n,this._abortController=null,this.itemStart=function(d){o++,s===!1&&i.onStart!==void 0&&i.onStart(d,r,o),s=!0},this.itemEnd=function(d){r++,i.onProgress!==void 0&&i.onProgress(d,r,o),r===o&&(s=!1,i.onLoad!==void 0&&i.onLoad())},this.itemError=function(d){i.onError!==void 0&&i.onError(d)},this.resolveURL=function(d){return d=d.normalize("NFC"),l?l(d):d},this.setURLModifier=function(d){return l=d,this},this.addHandler=function(d,p){return u.push(d,p),this},this.removeHandler=function(d){let p=u.indexOf(d);return p!==-1&&u.splice(p,2),this},this.getHandler=function(d){for(let p=0,c=u.length;p<c;p+=2){let h=u[p],v=u[p+1];if(h.global&&(h.lastIndex=0),h.test(d))return v}return null},this.abort=function(){return this.abortController.abort(),this._abortController=null,this}}get abortController(){return this._abortController||(this._abortController=new AbortController),this._abortController}},I0=new dc,hc=class{constructor(e){this.manager=e!==void 0?e:I0,this.crossOrigin="anonymous",this.withCredentials=!1,this.path="",this.resourcePath="",this.requestHeader={},typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}load(){}loadAsync(e,a){let n=this;return new Promise(function(i,s){n.load(e,i,a,s)})}parse(){}setCrossOrigin(e){return this.crossOrigin=e,this}setWithCredentials(e){return this.withCredentials=e,this}setPath(e){return this.path=e,this}setResourcePath(e){return this.resourcePath=e,this}setRequestHeader(e){return this.requestHeader=e,this}abort(){return this}};hc.DEFAULT_MATERIAL_NAME="__DEFAULT";var Pu=new F,Uu=new Un,En=new F,Xo=class extends en{constructor(){super(),this.isCamera=!0,this.type="Camera",this.matrixWorldInverse=new Ot,this.projectionMatrix=new Ot,this.projectionMatrixInverse=new Ot,this.coordinateSystem=xn,this._reversedDepth=!1}get reversedDepth(){return this._reversedDepth}copy(e,a){return super.copy(e,a),this.matrixWorldInverse.copy(e.matrixWorldInverse),this.projectionMatrix.copy(e.projectionMatrix),this.projectionMatrixInverse.copy(e.projectionMatrixInverse),this.coordinateSystem=e.coordinateSystem,this}getWorldDirection(e){return super.getWorldDirection(e).negate()}updateMatrixWorld(e){super.updateMatrixWorld(e),this.matrixWorld.decompose(Pu,Uu,En),En.x===1&&En.y===1&&En.z===1?this.matrixWorldInverse.copy(this.matrixWorld).invert():this.matrixWorldInverse.compose(Pu,Uu,En.set(1,1,1)).invert()}updateWorldMatrix(e,a,n=!1){super.updateWorldMatrix(e,a,n),this.matrixWorld.decompose(Pu,Uu,En),En.x===1&&En.y===1&&En.z===1?this.matrixWorldInverse.copy(this.matrixWorld).invert():this.matrixWorldInverse.compose(Pu,Uu,En.set(1,1,1)).invert()}clone(){return new this.constructor().copy(this)}},Bi=new F,Vx=new qe,Gx=new qe,ha=class extends Xo{constructor(e=50,a=1,n=.1,i=2e3){super(),this.isPerspectiveCamera=!0,this.type="PerspectiveCamera",this.fov=e,this.zoom=1,this.near=n,this.far=i,this.focus=10,this.aspect=a,this.view=null,this.filmGauge=35,this.filmOffset=0,this.updateProjectionMatrix()}copy(e,a){return super.copy(e,a),this.fov=e.fov,this.zoom=e.zoom,this.near=e.near,this.far=e.far,this.focus=e.focus,this.aspect=e.aspect,this.view=e.view===null?null:Object.assign({},e.view),this.filmGauge=e.filmGauge,this.filmOffset=e.filmOffset,this}setFocalLength(e){let a=.5*this.getFilmHeight()/e;this.fov=Zu*2*Math.atan(a),this.updateProjectionMatrix()}getFocalLength(){let e=Math.tan(eh*.5*this.fov);return .5*this.getFilmHeight()/e}getEffectiveFOV(){return Zu*2*Math.atan(Math.tan(eh*.5*this.fov)/this.zoom)}getFilmWidth(){return this.filmGauge*Math.min(this.aspect,1)}getFilmHeight(){return this.filmGauge/Math.max(this.aspect,1)}getViewBounds(e,a,n){Bi.set(-1,-1,.5).applyMatrix4(this.projectionMatrixInverse),a.set(Bi.x,Bi.y).multiplyScalar(-e/Bi.z),Bi.set(1,1,.5).applyMatrix4(this.projectionMatrixInverse),n.set(Bi.x,Bi.y).multiplyScalar(-e/Bi.z)}getViewSize(e,a){return this.getViewBounds(e,Vx,Gx),a.subVectors(Gx,Vx)}setViewOffset(e,a,n,i,s,r){this.aspect=e/a,this.view===null&&(this.view={enabled:!0,fullWidth:1,fullHeight:1,offsetX:0,offsetY:0,width:1,height:1}),this.view.enabled=!0,this.view.fullWidth=e,this.view.fullHeight=a,this.view.offsetX=n,this.view.offsetY=i,this.view.width=s,this.view.height=r,this.updateProjectionMatrix()}clearViewOffset(){this.view!==null&&(this.view.enabled=!1),this.updateProjectionMatrix()}updateProjectionMatrix(){let e=this.near,a=e*Math.tan(eh*.5*this.fov)/this.zoom,n=2*a,i=this.aspect*n,s=-.5*i,r=this.view;if(this.view!==null&&this.view.enabled){let l=r.fullWidth,u=r.fullHeight;s+=r.offsetX*i/l,a-=r.offsetY*n/u,i*=r.width/l,n*=r.height/u}let o=this.filmOffset;o!==0&&(s+=e*o/this.getFilmWidth()),this.projectionMatrix.makePerspective(s,s+i,a,a-n,e,this.far,this.coordinateSystem,this.reversedDepth),this.projectionMatrixInverse.copy(this.projectionMatrix).invert()}toJSON(e){let a=super.toJSON(e);return a.object.fov=this.fov,a.object.zoom=this.zoom,a.object.near=this.near,a.object.far=this.far,a.object.focus=this.focus,a.object.aspect=this.aspect,this.view!==null&&(a.object.view=Object.assign({},this.view)),a.object.filmGauge=this.filmGauge,a.object.filmOffset=this.filmOffset,a}};var Yo=class extends Xo{constructor(e=-1,a=1,n=1,i=-1,s=.1,r=2e3){super(),this.isOrthographicCamera=!0,this.type="OrthographicCamera",this.zoom=1,this.view=null,this.left=e,this.right=a,this.top=n,this.bottom=i,this.near=s,this.far=r,this.updateProjectionMatrix()}copy(e,a){return super.copy(e,a),this.left=e.left,this.right=e.right,this.top=e.top,this.bottom=e.bottom,this.near=e.near,this.far=e.far,this.zoom=e.zoom,this.view=e.view===null?null:Object.assign({},e.view),this}setViewOffset(e,a,n,i,s,r){this.view===null&&(this.view={enabled:!0,fullWidth:1,fullHeight:1,offsetX:0,offsetY:0,width:1,height:1}),this.view.enabled=!0,this.view.fullWidth=e,this.view.fullHeight=a,this.view.offsetX=n,this.view.offsetY=i,this.view.width=s,this.view.height=r,this.updateProjectionMatrix()}clearViewOffset(){this.view!==null&&(this.view.enabled=!1),this.updateProjectionMatrix()}updateProjectionMatrix(){let e=(this.right-this.left)/(2*this.zoom),a=(this.top-this.bottom)/(2*this.zoom),n=(this.right+this.left)/2,i=(this.top+this.bottom)/2,s=n-e,r=n+e,o=i+a,l=i-a;if(this.view!==null&&this.view.enabled){let u=(this.right-this.left)/this.view.fullWidth/this.zoom,d=(this.top-this.bottom)/this.view.fullHeight/this.zoom;s+=u*this.view.offsetX,r=s+u*this.view.width,o-=d*this.view.offsetY,l=o-d*this.view.height}this.projectionMatrix.makeOrthographic(s,r,o,l,this.near,this.far,this.coordinateSystem,this.reversedDepth),this.projectionMatrixInverse.copy(this.projectionMatrix).invert()}toJSON(e){let a=super.toJSON(e);return a.object.zoom=this.zoom,a.object.left=this.left,a.object.right=this.right,a.object.top=this.top,a.object.bottom=this.bottom,a.object.near=this.near,a.object.far=this.far,this.view!==null&&(a.object.view=Object.assign({},this.view)),a}};var vr=-90,yr=1,pc=class extends en{constructor(e,a,n){super(),this.type="CubeCamera",this.renderTarget=n,this.coordinateSystem=null,this.activeMipmapLevel=0;let i=new ha(vr,yr,e,a);i.layers=this.layers,this.add(i);let s=new ha(vr,yr,e,a);s.layers=this.layers,this.add(s);let r=new ha(vr,yr,e,a);r.layers=this.layers,this.add(r);let o=new ha(vr,yr,e,a);o.layers=this.layers,this.add(o);let l=new ha(vr,yr,e,a);l.layers=this.layers,this.add(l);let u=new ha(vr,yr,e,a);u.layers=this.layers,this.add(u)}updateCoordinateSystem(){let e=this.coordinateSystem,a=this.children.concat(),[n,i,s,r,o,l]=a;for(let u of a)this.remove(u);if(e===xn)n.up.set(0,1,0),n.lookAt(1,0,0),i.up.set(0,1,0),i.lookAt(-1,0,0),s.up.set(0,0,-1),s.lookAt(0,1,0),r.up.set(0,0,1),r.lookAt(0,-1,0),o.up.set(0,1,0),o.lookAt(0,0,1),l.up.set(0,1,0),l.lookAt(0,0,-1);else if(e===Uo)n.up.set(0,-1,0),n.lookAt(-1,0,0),i.up.set(0,-1,0),i.lookAt(1,0,0),s.up.set(0,0,1),s.lookAt(0,1,0),r.up.set(0,0,-1),r.lookAt(0,-1,0),o.up.set(0,-1,0),o.lookAt(0,0,1),l.up.set(0,-1,0),l.lookAt(0,0,-1);else throw new Error("THREE.CubeCamera.updateCoordinateSystem(): Invalid coordinate system: "+e);for(let u of a)this.add(u),u.updateMatrixWorld()}update(e,a){this.parent===null&&this.updateMatrixWorld();let{renderTarget:n,activeMipmapLevel:i}=this;this.coordinateSystem!==e.coordinateSystem&&(this.coordinateSystem=e.coordinateSystem,this.updateCoordinateSystem());let[s,r,o,l,u,d]=this.children,p=e.getRenderTarget(),c=e.getActiveCubeFace(),h=e.getActiveMipmapLevel(),v=e.xr.enabled;e.xr.enabled=!1;let b=n.texture.generateMipmaps;n.texture.generateMipmaps=!1;let m=!1;e.isWebGLRenderer===!0?m=e.state.buffers.depth.getReversed():m=e.reversedDepthBuffer,e.setRenderTarget(n,0,i),m&&e.autoClear===!1&&e.clearDepth(),e.render(a,s),e.setRenderTarget(n,1,i),m&&e.autoClear===!1&&e.clearDepth(),e.render(a,r),e.setRenderTarget(n,2,i),m&&e.autoClear===!1&&e.clearDepth(),e.render(a,o),e.setRenderTarget(n,3,i),m&&e.autoClear===!1&&e.clearDepth(),e.render(a,l),e.setRenderTarget(n,4,i),m&&e.autoClear===!1&&e.clearDepth(),e.render(a,u),n.texture.generateMipmaps=b,e.setRenderTarget(n,5,i),m&&e.autoClear===!1&&e.clearDepth(),e.render(a,d),e.setRenderTarget(p,c,h),e.xr.enabled=v,n.texture.needsPMREMUpdate=!0}},mc=class extends ha{constructor(e=[]){super(),this.isArrayCamera=!0,this.isMultiViewCamera=!1,this.cameras=e}};var tp="\\[\\]\\.:\\/",Qb=new RegExp("["+tp+"]","g"),ap="[^"+tp+"]",jb="[^"+tp.replace("\\.","")+"]",$b=/((?:WC+[\/:])*)/.source.replace("WC",ap),eC=/(WCOD+)?/.source.replace("WCOD",jb),tC=/(?:\.(WC+)(?:\[(.+)\])?)?/.source.replace("WC",ap),aC=/\.(WC+)(?:\[(.+)\])?/.source.replace("WC",ap),nC=new RegExp("^"+$b+eC+tC+aC+"$"),iC=["material","materials","bones","map"],Eh=class{constructor(e,a,n){let i=n||vt.parseTrackName(a);this._targetGroup=e,this._bindings=e.subscribe_(a,i)}getValue(e,a){this.bind();let n=this._targetGroup.nCachedObjects_,i=this._bindings[n];i!==void 0&&i.getValue(e,a)}setValue(e,a){let n=this._bindings;for(let i=this._targetGroup.nCachedObjects_,s=n.length;i!==s;++i)n[i].setValue(e,a)}bind(){let e=this._bindings;for(let a=this._targetGroup.nCachedObjects_,n=e.length;a!==n;++a)e[a].bind()}unbind(){let e=this._bindings;for(let a=this._targetGroup.nCachedObjects_,n=e.length;a!==n;++a)e[a].unbind()}},vt=class t{constructor(e,a,n){this.path=a,this.parsedPath=n||t.parseTrackName(a),this.node=t.findNode(e,this.parsedPath.nodeName),this.rootNode=e,this.getValue=this._getValue_unbound,this.setValue=this._setValue_unbound}static create(e,a,n){return e&&e.isAnimationObjectGroup?new t.Composite(e,a,n):new t(e,a,n)}static sanitizeNodeName(e){return e.replace(/\s/g,"_").replace(Qb,"")}static parseTrackName(e){let a=nC.exec(e);if(a===null)throw new Error("THREE.PropertyBinding: Cannot parse trackName: "+e);let n={nodeName:a[2],objectName:a[3],objectIndex:a[4],propertyName:a[5],propertyIndex:a[6]},i=n.nodeName&&n.nodeName.lastIndexOf(".");if(i!==void 0&&i!==-1){let s=n.nodeName.substring(i+1);iC.indexOf(s)!==-1&&(n.nodeName=n.nodeName.substring(0,i),n.objectName=s)}if(n.propertyName===null||n.propertyName.length===0)throw new Error("THREE.PropertyBinding: can not parse propertyName from trackName: "+e);return n}static findNode(e,a){if(a===void 0||a===""||a==="."||a===-1||a===e.name||a===e.uuid)return e;if(e.skeleton){let n=e.skeleton.getBoneByName(a);if(n!==void 0)return n}if(e.children){let n=function(s){for(let r=0;r<s.length;r++){let o=s[r];if(o.name===a||o.uuid===a)return o;let l=n(o.children);if(l)return l}return null},i=n(e.children);if(i)return i}return null}_getValue_unavailable(){}_setValue_unavailable(){}_getValue_direct(e,a){e[a]=this.targetObject[this.propertyName]}_getValue_array(e,a){let n=this.resolvedProperty;for(let i=0,s=n.length;i!==s;++i)e[a++]=n[i]}_getValue_arrayElement(e,a){e[a]=this.resolvedProperty[this.propertyIndex]}_getValue_toArray(e,a){this.resolvedProperty.toArray(e,a)}_setValue_direct(e,a){this.targetObject[this.propertyName]=e[a]}_setValue_direct_setNeedsUpdate(e,a){this.targetObject[this.propertyName]=e[a],this.targetObject.needsUpdate=!0}_setValue_direct_setMatrixWorldNeedsUpdate(e,a){this.targetObject[this.propertyName]=e[a],this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_array(e,a){let n=this.resolvedProperty;for(let i=0,s=n.length;i!==s;++i)n[i]=e[a++]}_setValue_array_setNeedsUpdate(e,a){let n=this.resolvedProperty;for(let i=0,s=n.length;i!==s;++i)n[i]=e[a++];this.targetObject.needsUpdate=!0}_setValue_array_setMatrixWorldNeedsUpdate(e,a){let n=this.resolvedProperty;for(let i=0,s=n.length;i!==s;++i)n[i]=e[a++];this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_arrayElement(e,a){this.resolvedProperty[this.propertyIndex]=e[a]}_setValue_arrayElement_setNeedsUpdate(e,a){this.resolvedProperty[this.propertyIndex]=e[a],this.targetObject.needsUpdate=!0}_setValue_arrayElement_setMatrixWorldNeedsUpdate(e,a){this.resolvedProperty[this.propertyIndex]=e[a],this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_fromArray(e,a){this.resolvedProperty.fromArray(e,a)}_setValue_fromArray_setNeedsUpdate(e,a){this.resolvedProperty.fromArray(e,a),this.targetObject.needsUpdate=!0}_setValue_fromArray_setMatrixWorldNeedsUpdate(e,a){this.resolvedProperty.fromArray(e,a),this.targetObject.matrixWorldNeedsUpdate=!0}_getValue_unbound(e,a){this.bind(),this.getValue(e,a)}_setValue_unbound(e,a){this.bind(),this.setValue(e,a)}bind(){let e=this.node,a=this.parsedPath,n=a.objectName,i=a.propertyName,s=a.propertyIndex;if(e||(e=t.findNode(this.rootNode,a.nodeName),this.node=e),this.getValue=this._getValue_unavailable,this.setValue=this._setValue_unavailable,!e){Ae("PropertyBinding: No target node found for track: "+this.path+".");return}if(n){let u=a.objectIndex;switch(n){case"materials":if(!e.material){Ee("PropertyBinding: Can not bind to material as node does not have a material.",this);return}if(!e.material.materials){Ee("PropertyBinding: Can not bind to material.materials as node.material does not have a materials array.",this);return}e=e.material.materials;break;case"bones":if(!e.skeleton){Ee("PropertyBinding: Can not bind to bones as node does not have a skeleton.",this);return}e=e.skeleton.bones;for(let d=0;d<e.length;d++)if(e[d].name===u){u=d;break}break;case"map":if("map"in e){e=e.map;break}if(!e.material){Ee("PropertyBinding: Can not bind to material as node does not have a material.",this);return}if(!e.material.map){Ee("PropertyBinding: Can not bind to material.map as node.material does not have a map.",this);return}e=e.material.map;break;default:if(e[n]===void 0){Ee("PropertyBinding: Can not bind to objectName of node undefined.",this);return}e=e[n]}if(u!==void 0){if(e[u]===void 0){Ee("PropertyBinding: Trying to bind to objectIndex of objectName, but is undefined.",this,e);return}e=e[u]}}let r=e[i];if(r===void 0){let u=a.nodeName;Ee("PropertyBinding: Trying to update property for track: "+u+"."+i+" but it wasn't found.",e);return}let o=this.Versioning.None;this.targetObject=e,e.isMaterial===!0?o=this.Versioning.NeedsUpdate:e.isObject3D===!0&&(o=this.Versioning.MatrixWorldNeedsUpdate);let l=this.BindingType.Direct;if(s!==void 0){if(i==="morphTargetInfluences"){if(!e.geometry){Ee("PropertyBinding: Can not bind to morphTargetInfluences because node does not have a geometry.",this);return}if(!e.geometry.morphAttributes){Ee("PropertyBinding: Can not bind to morphTargetInfluences because node does not have a geometry.morphAttributes.",this);return}e.morphTargetDictionary[s]!==void 0&&(s=e.morphTargetDictionary[s])}l=this.BindingType.ArrayElement,this.resolvedProperty=r,this.propertyIndex=s}else r.fromArray!==void 0&&r.toArray!==void 0?(l=this.BindingType.HasFromToArray,this.resolvedProperty=r):Array.isArray(r)?(l=this.BindingType.EntireArray,this.resolvedProperty=r):this.propertyName=i;this.getValue=this.GetterByBindingType[l],this.setValue=this.SetterByBindingTypeAndVersioning[l][o]}unbind(){this.node=null,this.getValue=this._getValue_unbound,this.setValue=this._setValue_unbound}};vt.Composite=Eh;vt.prototype.BindingType={Direct:0,EntireArray:1,ArrayElement:2,HasFromToArray:3};vt.prototype.Versioning={None:0,NeedsUpdate:1,MatrixWorldNeedsUpdate:2};vt.prototype.GetterByBindingType=[vt.prototype._getValue_direct,vt.prototype._getValue_array,vt.prototype._getValue_arrayElement,vt.prototype._getValue_toArray];vt.prototype.SetterByBindingTypeAndVersioning=[[vt.prototype._setValue_direct,vt.prototype._setValue_direct_setNeedsUpdate,vt.prototype._setValue_direct_setMatrixWorldNeedsUpdate],[vt.prototype._setValue_array,vt.prototype._setValue_array_setNeedsUpdate,vt.prototype._setValue_array_setMatrixWorldNeedsUpdate],[vt.prototype._setValue_arrayElement,vt.prototype._setValue_arrayElement_setNeedsUpdate,vt.prototype._setValue_arrayElement_setMatrixWorldNeedsUpdate],[vt.prototype._setValue_fromArray,vt.prototype._setValue_fromArray_setNeedsUpdate,vt.prototype._setValue_fromArray_setMatrixWorldNeedsUpdate]];var oR=new Float32Array(1);var Zo=class{constructor(e=!0){this.autoStart=e,this.startTime=0,this.oldTime=0,this.elapsedTime=0,this.running=!1,Ae("Clock: This module has been deprecated. Please use THREE.Timer instead.")}start(){this.startTime=performance.now(),this.oldTime=this.startTime,this.elapsedTime=0,this.running=!0}stop(){this.getElapsedTime(),this.running=!1,this.autoStart=!1}getElapsedTime(){return this.getDelta(),this.elapsedTime}getDelta(){let e=0;if(this.autoStart&&!this.running)return this.start(),0;if(this.running){let a=performance.now();e=(a-this.oldTime)/1e3,this.oldTime=a,this.elapsedTime+=e}return e}};var wh=class t{static{t.prototype.isMatrix2=!0}constructor(e,a,n,i){this.elements=[1,0,0,1],e!==void 0&&this.set(e,a,n,i)}identity(){return this.set(1,0,0,1),this}fromArray(e,a=0){for(let n=0;n<4;n++)this.elements[n]=e[n+a];return this}set(e,a,n,i){let s=this.elements;return s[0]=e,s[2]=a,s[1]=n,s[3]=i,this}};function np(t,e,a,n){let i=sC(n);switch(a){case Zh:return t*e;case Jh:return t*e/i.components*i.byteLength;case Mc:return t*e/i.components*i.byteLength;case Xi:return t*e*2/i.components*i.byteLength;case bc:return t*e*2/i.components*i.byteLength;case Kh:return t*e*3/i.components*i.byteLength;case tn:return t*e*4/i.components*i.byteLength;case Cc:return t*e*4/i.components*i.byteLength;case jo:case $o:return Math.floor((t+3)/4)*Math.floor((e+3)/4)*8;case el:case tl:return Math.floor((t+3)/4)*Math.floor((e+3)/4)*16;case Ac:case Ic:return Math.max(t,16)*Math.max(e,8)/4;case Lc:case Tc:return Math.max(t,8)*Math.max(e,8)/2;case Ec:case wc:case Dc:case Pc:return Math.floor((t+3)/4)*Math.floor((e+3)/4)*8;case Rc:case al:case Uc:return Math.floor((t+3)/4)*Math.floor((e+3)/4)*16;case Bc:return Math.floor((t+3)/4)*Math.floor((e+3)/4)*16;case Oc:return Math.floor((t+4)/5)*Math.floor((e+3)/4)*16;case Nc:return Math.floor((t+4)/5)*Math.floor((e+4)/5)*16;case Fc:return Math.floor((t+5)/6)*Math.floor((e+4)/5)*16;case zc:return Math.floor((t+5)/6)*Math.floor((e+5)/6)*16;case kc:return Math.floor((t+7)/8)*Math.floor((e+4)/5)*16;case Hc:return Math.floor((t+7)/8)*Math.floor((e+5)/6)*16;case Vc:return Math.floor((t+7)/8)*Math.floor((e+7)/8)*16;case Gc:return Math.floor((t+9)/10)*Math.floor((e+4)/5)*16;case qc:return Math.floor((t+9)/10)*Math.floor((e+5)/6)*16;case Wc:return Math.floor((t+9)/10)*Math.floor((e+7)/8)*16;case Xc:return Math.floor((t+9)/10)*Math.floor((e+9)/10)*16;case Yc:return Math.floor((t+11)/12)*Math.floor((e+9)/10)*16;case Zc:return Math.floor((t+11)/12)*Math.floor((e+11)/12)*16;case Kc:case Jc:case Qc:return Math.ceil(t/4)*Math.ceil(e/4)*16;case jc:case $c:return Math.ceil(t/4)*Math.ceil(e/4)*8;case nl:case ef:return Math.ceil(t/4)*Math.ceil(e/4)*16}throw new Error(`Unable to determine texture byte length for ${a} format.`)}function sC(t){switch(t){case ka:case qh:return{byteLength:1,components:1};case Tr:case Wh:case Fn:return{byteLength:2,components:1};case _c:case Sc:return{byteLength:2,components:4};case yn:case yc:case _n:return{byteLength:4,components:1};case Xh:case Yh:return{byteLength:4,components:3}}throw new Error(`THREE.TextureUtils: Unknown texture type ${t}.`)}typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("register",{detail:{revision:"185"}}));typeof window<"u"&&(window.__THREE__?Ae("WARNING: Multiple instances of Three.js being imported."):window.__THREE__="185");function Q0(){let t=null,e=!1,a=null,n=null;function i(s,r){a(s,r),n=t.requestAnimationFrame(i)}return{start:function(){e!==!0&&a!==null&&t!==null&&(n=t.requestAnimationFrame(i),e=!0)},stop:function(){t!==null&&t.cancelAnimationFrame(n),e=!1},setAnimationLoop:function(s){a=s},setContext:function(s){t=s}}}function oC(t){let e=new WeakMap;function a(o,l){let u=o.array,d=o.usage,p=u.byteLength,c=t.createBuffer();t.bindBuffer(l,c),t.bufferData(l,u,d),o.onUploadCallback();let h;if(u instanceof Float32Array)h=t.FLOAT;else if(typeof Float16Array<"u"&&u instanceof Float16Array)h=t.HALF_FLOAT;else if(u instanceof Uint16Array)o.isFloat16BufferAttribute?h=t.HALF_FLOAT:h=t.UNSIGNED_SHORT;else if(u instanceof Int16Array)h=t.SHORT;else if(u instanceof Uint32Array)h=t.UNSIGNED_INT;else if(u instanceof Int32Array)h=t.INT;else if(u instanceof Int8Array)h=t.BYTE;else if(u instanceof Uint8Array)h=t.UNSIGNED_BYTE;else if(u instanceof Uint8ClampedArray)h=t.UNSIGNED_BYTE;else throw new Error("THREE.WebGLAttributes: Unsupported buffer data format: "+u);return{buffer:c,type:h,bytesPerElement:u.BYTES_PER_ELEMENT,version:o.version,size:p}}function n(o,l,u){let d=l.array,p=l.updateRanges;if(t.bindBuffer(u,o),p.length===0)t.bufferSubData(u,0,d);else{p.sort((h,v)=>h.start-v.start);let c=0;for(let h=1;h<p.length;h++){let v=p[c],b=p[h];b.start<=v.start+v.count+1?v.count=Math.max(v.count,b.start+b.count-v.start):(++c,p[c]=b)}p.length=c+1;for(let h=0,v=p.length;h<v;h++){let b=p[h];t.bufferSubData(u,b.start*d.BYTES_PER_ELEMENT,d,b.start,b.count)}l.clearUpdateRanges()}l.onUploadCallback()}function i(o){return o.isInterleavedBufferAttribute&&(o=o.data),e.get(o)}function s(o){o.isInterleavedBufferAttribute&&(o=o.data);let l=e.get(o);l&&(t.deleteBuffer(l.buffer),e.delete(o))}function r(o,l){if(o.isInterleavedBufferAttribute&&(o=o.data),o.isGLBufferAttribute){let d=e.get(o);(!d||d.version<o.version)&&e.set(o,{buffer:o.buffer,type:o.type,bytesPerElement:o.elementSize,version:o.version});return}let u=e.get(o);if(u===void 0)e.set(o,a(o,l));else if(u.version<o.version){if(u.size!==o.array.byteLength)throw new Error("THREE.WebGLAttributes: The size of the buffer attribute's array buffer does not match the original size. Resizing buffer attributes is not supported.");n(u.buffer,o,l),u.version=o.version}}return{get:i,remove:s,update:r}}var lC=`#ifdef USE_ALPHAHASH
	if ( diffuseColor.a < getAlphaHashThreshold( vPosition ) ) discard;
#endif`,uC=`#ifdef USE_ALPHAHASH
	const float ALPHA_HASH_SCALE = 0.05;
	float hash2D( vec2 value ) {
		return fract( 1.0e4 * sin( 17.0 * value.x + 0.1 * value.y ) * ( 0.1 + abs( sin( 13.0 * value.y + value.x ) ) ) );
	}
	float hash3D( vec3 value ) {
		return hash2D( vec2( hash2D( value.xy ), value.z ) );
	}
	float getAlphaHashThreshold( vec3 position ) {
		float maxDeriv = max(
			length( dFdx( position.xyz ) ),
			length( dFdy( position.xyz ) )
		);
		float pixScale = 1.0 / ( ALPHA_HASH_SCALE * maxDeriv );
		vec2 pixScales = vec2(
			exp2( floor( log2( pixScale ) ) ),
			exp2( ceil( log2( pixScale ) ) )
		);
		vec2 alpha = vec2(
			hash3D( floor( pixScales.x * position.xyz ) ),
			hash3D( floor( pixScales.y * position.xyz ) )
		);
		float lerpFactor = fract( log2( pixScale ) );
		float x = ( 1.0 - lerpFactor ) * alpha.x + lerpFactor * alpha.y;
		float a = min( lerpFactor, 1.0 - lerpFactor );
		vec3 cases = vec3(
			x * x / ( 2.0 * a * ( 1.0 - a ) ),
			( x - 0.5 * a ) / ( 1.0 - a ),
			1.0 - ( ( 1.0 - x ) * ( 1.0 - x ) / ( 2.0 * a * ( 1.0 - a ) ) )
		);
		float threshold = ( x < ( 1.0 - a ) )
			? ( ( x < a ) ? cases.x : cases.y )
			: cases.z;
		return clamp( threshold , 1.0e-6, 1.0 );
	}
#endif`,cC=`#ifdef USE_ALPHAMAP
	diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).g;
#endif`,fC=`#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,dC=`#ifdef USE_ALPHATEST
	#ifdef ALPHA_TO_COVERAGE
	diffuseColor.a = smoothstep( alphaTest, alphaTest + fwidth( diffuseColor.a ), diffuseColor.a );
	if ( diffuseColor.a == 0.0 ) discard;
	#else
	if ( diffuseColor.a < alphaTest ) discard;
	#endif
#endif`,hC=`#ifdef USE_ALPHATEST
	uniform float alphaTest;
#endif`,pC=`#ifdef USE_AOMAP
	float ambientOcclusion = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;
	reflectedLight.indirectDiffuse *= ambientOcclusion;
	#if defined( USE_CLEARCOAT ) 
		clearcoatSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_SHEEN ) 
		sheenSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD )
		float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
	#endif
#endif`,mC=`#ifdef USE_AOMAP
	uniform sampler2D aoMap;
	uniform float aoMapIntensity;
#endif`,gC=`#ifdef USE_BATCHING
	#if ! defined( GL_ANGLE_multi_draw )
	#define gl_DrawID _gl_DrawID
	uniform int _gl_DrawID;
	#endif
	uniform highp sampler2D batchingTexture;
	uniform highp usampler2D batchingIdTexture;
	mat4 getBatchingMatrix( const in float i ) {
		int size = textureSize( batchingTexture, 0 ).x;
		int j = int( i ) * 4;
		int x = j % size;
		int y = j / size;
		vec4 v1 = texelFetch( batchingTexture, ivec2( x, y ), 0 );
		vec4 v2 = texelFetch( batchingTexture, ivec2( x + 1, y ), 0 );
		vec4 v3 = texelFetch( batchingTexture, ivec2( x + 2, y ), 0 );
		vec4 v4 = texelFetch( batchingTexture, ivec2( x + 3, y ), 0 );
		return mat4( v1, v2, v3, v4 );
	}
	float getIndirectIndex( const in int i ) {
		int size = textureSize( batchingIdTexture, 0 ).x;
		int x = i % size;
		int y = i / size;
		return float( texelFetch( batchingIdTexture, ivec2( x, y ), 0 ).r );
	}
#endif
#ifdef USE_BATCHING_COLOR
	uniform sampler2D batchingColorTexture;
	vec4 getBatchingColor( const in float i ) {
		int size = textureSize( batchingColorTexture, 0 ).x;
		int j = int( i );
		int x = j % size;
		int y = j / size;
		return texelFetch( batchingColorTexture, ivec2( x, y ), 0 );
	}
#endif`,xC=`#ifdef USE_BATCHING
	mat4 batchingMatrix = getBatchingMatrix( getIndirectIndex( gl_DrawID ) );
#endif`,vC=`vec3 transformed = vec3( position );
#ifdef USE_ALPHAHASH
	vPosition = vec3( position );
#endif`,yC=`vec3 objectNormal = vec3( normal );
#ifdef USE_TANGENT
	vec3 objectTangent = vec3( tangent.xyz );
#endif`,_C=`float G_BlinnPhong_Implicit( ) {
	return 0.25;
}
float D_BlinnPhong( const in float shininess, const in float dotNH ) {
	return RECIPROCAL_PI * ( shininess * 0.5 + 1.0 ) * pow( dotNH, shininess );
}
vec3 BRDF_BlinnPhong( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in vec3 specularColor, const in float shininess ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( specularColor, 1.0, dotVH );
	float G = G_BlinnPhong_Implicit( );
	float D = D_BlinnPhong( shininess, dotNH );
	return F * ( G * D );
} // validated`,SC=`#ifdef USE_IRIDESCENCE
	const mat3 XYZ_TO_REC709 = mat3(
		 3.2404542, -0.9692660,  0.0556434,
		-1.5371385,  1.8760108, -0.2040259,
		-0.4985314,  0.0415560,  1.0572252
	);
	vec3 Fresnel0ToIor( vec3 fresnel0 ) {
		vec3 sqrtF0 = sqrt( fresnel0 );
		return ( vec3( 1.0 ) + sqrtF0 ) / ( vec3( 1.0 ) - sqrtF0 );
	}
	vec3 IorToFresnel0( vec3 transmittedIor, float incidentIor ) {
		return pow2( ( transmittedIor - vec3( incidentIor ) ) / ( transmittedIor + vec3( incidentIor ) ) );
	}
	float IorToFresnel0( float transmittedIor, float incidentIor ) {
		return pow2( ( transmittedIor - incidentIor ) / ( transmittedIor + incidentIor ));
	}
	vec3 evalSensitivity( float OPD, vec3 shift ) {
		float phase = 2.0 * PI * OPD * 1.0e-9;
		vec3 val = vec3( 5.4856e-13, 4.4201e-13, 5.2481e-13 );
		vec3 pos = vec3( 1.6810e+06, 1.7953e+06, 2.2084e+06 );
		vec3 var = vec3( 4.3278e+09, 9.3046e+09, 6.6121e+09 );
		vec3 xyz = val * sqrt( 2.0 * PI * var ) * cos( pos * phase + shift ) * exp( - pow2( phase ) * var );
		xyz.x += 9.7470e-14 * sqrt( 2.0 * PI * 4.5282e+09 ) * cos( 2.2399e+06 * phase + shift[ 0 ] ) * exp( - 4.5282e+09 * pow2( phase ) );
		xyz /= 1.0685e-7;
		vec3 rgb = XYZ_TO_REC709 * xyz;
		return rgb;
	}
	vec3 evalIridescence( float outsideIOR, float eta2, float cosTheta1, float thinFilmThickness, vec3 baseF0 ) {
		vec3 I;
		float iridescenceIOR = mix( outsideIOR, eta2, smoothstep( 0.0, 0.03, thinFilmThickness ) );
		float sinTheta2Sq = pow2( outsideIOR / iridescenceIOR ) * ( 1.0 - pow2( cosTheta1 ) );
		float cosTheta2Sq = 1.0 - sinTheta2Sq;
		if ( cosTheta2Sq < 0.0 ) {
			return vec3( 1.0 );
		}
		float cosTheta2 = sqrt( cosTheta2Sq );
		float R0 = IorToFresnel0( iridescenceIOR, outsideIOR );
		float R12 = F_Schlick( R0, 1.0, cosTheta1 );
		float T121 = 1.0 - R12;
		float phi12 = 0.0;
		if ( iridescenceIOR < outsideIOR ) phi12 = PI;
		float phi21 = PI - phi12;
		vec3 baseIOR = Fresnel0ToIor( clamp( baseF0, 0.0, 0.9999 ) );		vec3 R1 = IorToFresnel0( baseIOR, iridescenceIOR );
		vec3 R23 = F_Schlick( R1, 1.0, cosTheta2 );
		vec3 phi23 = vec3( 0.0 );
		if ( baseIOR[ 0 ] < iridescenceIOR ) phi23[ 0 ] = PI;
		if ( baseIOR[ 1 ] < iridescenceIOR ) phi23[ 1 ] = PI;
		if ( baseIOR[ 2 ] < iridescenceIOR ) phi23[ 2 ] = PI;
		float OPD = 2.0 * iridescenceIOR * thinFilmThickness * cosTheta2;
		vec3 phi = vec3( phi21 ) + phi23;
		vec3 R123 = clamp( R12 * R23, 1e-5, 0.9999 );
		vec3 r123 = sqrt( R123 );
		vec3 Rs = pow2( T121 ) * R23 / ( vec3( 1.0 ) - R123 );
		vec3 C0 = R12 + Rs;
		I = C0;
		vec3 Cm = Rs - T121;
		for ( int m = 1; m <= 2; ++ m ) {
			Cm *= r123;
			vec3 Sm = 2.0 * evalSensitivity( float( m ) * OPD, float( m ) * phi );
			I += Cm * Sm;
		}
		return max( I, vec3( 0.0 ) );
	}
#endif`,MC=`#ifdef USE_BUMPMAP
	uniform sampler2D bumpMap;
	uniform float bumpScale;
	vec2 dHdxy_fwd() {
		vec2 dSTdx = dFdx( vBumpMapUv );
		vec2 dSTdy = dFdy( vBumpMapUv );
		float Hll = bumpScale * texture2D( bumpMap, vBumpMapUv ).x;
		float dBx = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdx ).x - Hll;
		float dBy = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdy ).x - Hll;
		return vec2( dBx, dBy );
	}
	vec3 perturbNormalArb( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection ) {
		vec3 vSigmaX = normalize( dFdx( surf_pos.xyz ) );
		vec3 vSigmaY = normalize( dFdy( surf_pos.xyz ) );
		vec3 vN = surf_norm;
		vec3 R1 = cross( vSigmaY, vN );
		vec3 R2 = cross( vN, vSigmaX );
		float fDet = dot( vSigmaX, R1 ) * faceDirection;
		vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
		return normalize( abs( fDet ) * surf_norm - vGrad );
	}
#endif`,bC=`#if NUM_CLIPPING_PLANES > 0
	vec4 plane;
	#ifdef ALPHA_TO_COVERAGE
		float distanceToPlane, distanceGradient;
		float clipOpacity = 1.0;
		#pragma unroll_loop_start
		for ( int i = 0; i < UNION_CLIPPING_PLANES; i ++ ) {
			plane = clippingPlanes[ i ];
			distanceToPlane = - dot( vClipPosition, plane.xyz ) + plane.w;
			distanceGradient = fwidth( distanceToPlane ) / 2.0;
			clipOpacity *= smoothstep( - distanceGradient, distanceGradient, distanceToPlane );
			if ( clipOpacity == 0.0 ) discard;
		}
		#pragma unroll_loop_end
		#if UNION_CLIPPING_PLANES < NUM_CLIPPING_PLANES
			float unionClipOpacity = 1.0;
			#pragma unroll_loop_start
			for ( int i = UNION_CLIPPING_PLANES; i < NUM_CLIPPING_PLANES; i ++ ) {
				plane = clippingPlanes[ i ];
				distanceToPlane = - dot( vClipPosition, plane.xyz ) + plane.w;
				distanceGradient = fwidth( distanceToPlane ) / 2.0;
				unionClipOpacity *= 1.0 - smoothstep( - distanceGradient, distanceGradient, distanceToPlane );
			}
			#pragma unroll_loop_end
			clipOpacity *= 1.0 - unionClipOpacity;
		#endif
		diffuseColor.a *= clipOpacity;
		if ( diffuseColor.a == 0.0 ) discard;
	#else
		#pragma unroll_loop_start
		for ( int i = 0; i < UNION_CLIPPING_PLANES; i ++ ) {
			plane = clippingPlanes[ i ];
			if ( dot( vClipPosition, plane.xyz ) > plane.w ) discard;
		}
		#pragma unroll_loop_end
		#if UNION_CLIPPING_PLANES < NUM_CLIPPING_PLANES
			bool clipped = true;
			#pragma unroll_loop_start
			for ( int i = UNION_CLIPPING_PLANES; i < NUM_CLIPPING_PLANES; i ++ ) {
				plane = clippingPlanes[ i ];
				clipped = ( dot( vClipPosition, plane.xyz ) > plane.w ) && clipped;
			}
			#pragma unroll_loop_end
			if ( clipped ) discard;
		#endif
	#endif
#endif`,CC=`#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
	uniform vec4 clippingPlanes[ NUM_CLIPPING_PLANES ];
#endif`,LC=`#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
#endif`,AC=`#if NUM_CLIPPING_PLANES > 0
	vClipPosition = - mvPosition.xyz;
#endif`,TC=`#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	diffuseColor *= vColor;
#endif`,IC=`#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	varying vec4 vColor;
#endif`,EC=`#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
	varying vec4 vColor;
#endif`,wC=`#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
	vColor = vec4( 1.0 );
#endif
#ifdef USE_COLOR_ALPHA
	vColor *= color;
#elif defined( USE_COLOR )
	vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
	vColor.rgb *= instanceColor.rgb;
#endif
#ifdef USE_BATCHING_COLOR
	vColor *= getBatchingColor( getIndirectIndex( gl_DrawID ) );
#endif`,RC=`#define PI 3.141592653589793
#define PI2 6.283185307179586
#define PI_HALF 1.5707963267948966
#define RECIPROCAL_PI 0.3183098861837907
#define RECIPROCAL_PI2 0.15915494309189535
#define EPSILON 1e-6
#ifndef saturate
#define saturate( a ) clamp( a, 0.0, 1.0 )
#endif
#define whiteComplement( a ) ( 1.0 - saturate( a ) )
float pow2( const in float x ) { return x*x; }
vec3 pow2( const in vec3 x ) { return x*x; }
float pow3( const in float x ) { return x*x*x; }
float pow4( const in float x ) { float x2 = x*x; return x2*x2; }
float max3( const in vec3 v ) { return max( max( v.x, v.y ), v.z ); }
float average( const in vec3 v ) { return dot( v, vec3( 0.3333333 ) ); }
highp float rand( const in vec2 uv ) {
	const highp float a = 12.9898, b = 78.233, c = 43758.5453;
	highp float dt = dot( uv.xy, vec2( a,b ) ), sn = mod( dt, PI );
	return fract( sin( sn ) * c );
}
#ifdef HIGH_PRECISION
	float precisionSafeLength( vec3 v ) { return length( v ); }
#else
	float precisionSafeLength( vec3 v ) {
		float maxComponent = max3( abs( v ) );
		return length( v / maxComponent ) * maxComponent;
	}
#endif
struct IncidentLight {
	vec3 color;
	vec3 direction;
	bool visible;
};
struct ReflectedLight {
	vec3 directDiffuse;
	vec3 directSpecular;
	vec3 indirectDiffuse;
	vec3 indirectSpecular;
};
#ifdef USE_ALPHAHASH
	varying vec3 vPosition;
#endif
vec3 transformDirection( in vec3 dir, in mat4 matrix ) {
	return normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );
}
#define inverseTransformDirection transformDirectionByInverseViewMatrix
vec3 transformNormalByInverseViewMatrix( in vec3 normal, in mat4 viewMatrix ) {
	return normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
}
vec3 transformDirectionByInverseViewMatrix( in vec3 dir, in mat4 viewMatrix ) {
	return normalize( ( vec4( dir, 0.0 ) * viewMatrix ).xyz );
}
bool isPerspectiveMatrix( mat4 m ) {
	return m[ 2 ][ 3 ] == - 1.0;
}
vec2 equirectUv( in vec3 dir ) {
	float u = atan( dir.z, dir.x ) * RECIPROCAL_PI2 + 0.5;
	float v = asin( clamp( dir.y, - 1.0, 1.0 ) ) * RECIPROCAL_PI + 0.5;
	return vec2( u, v );
}
vec3 BRDF_Lambert( const in vec3 diffuseColor ) {
	return RECIPROCAL_PI * diffuseColor;
}
vec3 F_Schlick( const in vec3 f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
}
float F_Schlick( const in float f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
} // validated`,DC=`#ifdef ENVMAP_TYPE_CUBE_UV
	#define cubeUV_minMipLevel 4.0
	#define cubeUV_minTileSize 16.0
	float getFace( vec3 direction ) {
		vec3 absDirection = abs( direction );
		float face = - 1.0;
		if ( absDirection.x > absDirection.z ) {
			if ( absDirection.x > absDirection.y )
				face = direction.x > 0.0 ? 0.0 : 3.0;
			else
				face = direction.y > 0.0 ? 1.0 : 4.0;
		} else {
			if ( absDirection.z > absDirection.y )
				face = direction.z > 0.0 ? 2.0 : 5.0;
			else
				face = direction.y > 0.0 ? 1.0 : 4.0;
		}
		return face;
	}
	vec2 getUV( vec3 direction, float face ) {
		vec2 uv;
		if ( face == 0.0 ) {
			uv = vec2( direction.z, direction.y ) / abs( direction.x );
		} else if ( face == 1.0 ) {
			uv = vec2( - direction.x, - direction.z ) / abs( direction.y );
		} else if ( face == 2.0 ) {
			uv = vec2( - direction.x, direction.y ) / abs( direction.z );
		} else if ( face == 3.0 ) {
			uv = vec2( - direction.z, direction.y ) / abs( direction.x );
		} else if ( face == 4.0 ) {
			uv = vec2( - direction.x, direction.z ) / abs( direction.y );
		} else {
			uv = vec2( direction.x, direction.y ) / abs( direction.z );
		}
		return 0.5 * ( uv + 1.0 );
	}
	vec3 bilinearCubeUV( sampler2D envMap, vec3 direction, float mipInt ) {
		float face = getFace( direction );
		float filterInt = max( cubeUV_minMipLevel - mipInt, 0.0 );
		mipInt = max( mipInt, cubeUV_minMipLevel );
		float faceSize = exp2( mipInt );
		highp vec2 uv = getUV( direction, face ) * ( faceSize - 2.0 ) + 1.0;
		if ( face > 2.0 ) {
			uv.y += faceSize;
			face -= 3.0;
		}
		uv.x += face * faceSize;
		uv.x += filterInt * 3.0 * cubeUV_minTileSize;
		uv.y += 4.0 * ( exp2( CUBEUV_MAX_MIP ) - faceSize );
		uv.x *= CUBEUV_TEXEL_WIDTH;
		uv.y *= CUBEUV_TEXEL_HEIGHT;
		#ifdef texture2DGradEXT
			return texture2DGradEXT( envMap, uv, vec2( 0.0 ), vec2( 0.0 ) ).rgb;
		#else
			return texture2D( envMap, uv ).rgb;
		#endif
	}
	#define cubeUV_r0 1.0
	#define cubeUV_m0 - 2.0
	#define cubeUV_r1 0.8
	#define cubeUV_m1 - 1.0
	#define cubeUV_r4 0.4
	#define cubeUV_m4 2.0
	#define cubeUV_r5 0.305
	#define cubeUV_m5 3.0
	#define cubeUV_r6 0.21
	#define cubeUV_m6 4.0
	float roughnessToMip( float roughness ) {
		float mip = 0.0;
		if ( roughness >= cubeUV_r1 ) {
			mip = ( cubeUV_r0 - roughness ) * ( cubeUV_m1 - cubeUV_m0 ) / ( cubeUV_r0 - cubeUV_r1 ) + cubeUV_m0;
		} else if ( roughness >= cubeUV_r4 ) {
			mip = ( cubeUV_r1 - roughness ) * ( cubeUV_m4 - cubeUV_m1 ) / ( cubeUV_r1 - cubeUV_r4 ) + cubeUV_m1;
		} else if ( roughness >= cubeUV_r5 ) {
			mip = ( cubeUV_r4 - roughness ) * ( cubeUV_m5 - cubeUV_m4 ) / ( cubeUV_r4 - cubeUV_r5 ) + cubeUV_m4;
		} else if ( roughness >= cubeUV_r6 ) {
			mip = ( cubeUV_r5 - roughness ) * ( cubeUV_m6 - cubeUV_m5 ) / ( cubeUV_r5 - cubeUV_r6 ) + cubeUV_m5;
		} else {
			mip = - 2.0 * log2( 1.16 * roughness );		}
		return mip;
	}
	vec4 textureCubeUV( sampler2D envMap, vec3 sampleDir, float roughness ) {
		float mip = clamp( roughnessToMip( roughness ), cubeUV_m0, CUBEUV_MAX_MIP );
		float mipF = fract( mip );
		float mipInt = floor( mip );
		vec3 color0 = bilinearCubeUV( envMap, sampleDir, mipInt );
		if ( mipF == 0.0 ) {
			return vec4( color0, 1.0 );
		} else {
			vec3 color1 = bilinearCubeUV( envMap, sampleDir, mipInt + 1.0 );
			return vec4( mix( color0, color1, mipF ), 1.0 );
		}
	}
#endif`,PC=`vec3 transformedNormal = objectNormal;
#ifdef USE_TANGENT
	vec3 transformedTangent = objectTangent;
#endif
#ifdef USE_BATCHING
	mat3 bm = mat3( batchingMatrix );
	transformedNormal /= vec3( dot( bm[ 0 ], bm[ 0 ] ), dot( bm[ 1 ], bm[ 1 ] ), dot( bm[ 2 ], bm[ 2 ] ) );
	transformedNormal = bm * transformedNormal;
	#ifdef USE_TANGENT
		transformedTangent = bm * transformedTangent;
	#endif
#endif
#ifdef USE_INSTANCING
	mat3 im = mat3( instanceMatrix );
	transformedNormal /= vec3( dot( im[ 0 ], im[ 0 ] ), dot( im[ 1 ], im[ 1 ] ), dot( im[ 2 ], im[ 2 ] ) );
	transformedNormal = im * transformedNormal;
	#ifdef USE_TANGENT
		transformedTangent = im * transformedTangent;
	#endif
#endif
transformedNormal = normalMatrix * transformedNormal;
#ifdef FLIP_SIDED
	transformedNormal = - transformedNormal;
#endif
#ifdef USE_TANGENT
	transformedTangent = ( modelViewMatrix * vec4( transformedTangent, 0.0 ) ).xyz;
#endif`,UC=`#ifdef USE_DISPLACEMENTMAP
	uniform sampler2D displacementMap;
	uniform float displacementScale;
	uniform float displacementBias;
#endif`,BC=`#ifdef USE_DISPLACEMENTMAP
	transformed += normalize( objectNormal ) * ( texture2D( displacementMap, vDisplacementMapUv ).x * displacementScale + displacementBias );
#endif`,OC=`#ifdef USE_EMISSIVEMAP
	vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
	#ifdef DECODE_VIDEO_TEXTURE_EMISSIVE
		emissiveColor = sRGBTransferEOTF( emissiveColor );
	#endif
	totalEmissiveRadiance *= emissiveColor.rgb;
#endif`,NC=`#ifdef USE_EMISSIVEMAP
	uniform sampler2D emissiveMap;
#endif`,FC="gl_FragColor = linearToOutputTexel( gl_FragColor );",zC=`vec4 LinearTransferOETF( in vec4 value ) {
	return value;
}
vec4 sRGBTransferEOTF( in vec4 value ) {
	return vec4( mix( pow( value.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), value.rgb * 0.0773993808, vec3( lessThanEqual( value.rgb, vec3( 0.04045 ) ) ) ), value.a );
}
vec4 sRGBTransferOETF( in vec4 value ) {
	return vec4( mix( pow( value.rgb, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), value.rgb * 12.92, vec3( lessThanEqual( value.rgb, vec3( 0.0031308 ) ) ) ), value.a );
}`,kC=`#ifdef USE_ENVMAP
	#ifdef ENV_WORLDPOS
		vec3 cameraToFrag;
		if ( isOrthographic ) {
			cameraToFrag = normalize( vec3( - viewMatrix[ 0 ][ 2 ], - viewMatrix[ 1 ][ 2 ], - viewMatrix[ 2 ][ 2 ] ) );
		} else {
			cameraToFrag = normalize( vWorldPosition - cameraPosition );
		}
		vec3 worldNormal = transformNormalByInverseViewMatrix( normal, viewMatrix );
		#ifdef ENVMAP_MODE_REFLECTION
			vec3 reflectVec = reflect( cameraToFrag, worldNormal );
		#else
			vec3 reflectVec = refract( cameraToFrag, worldNormal, refractionRatio );
		#endif
	#else
		vec3 reflectVec = vReflect;
	#endif
	#ifdef ENVMAP_TYPE_CUBE
		vec4 envColor = textureCube( envMap, envMapRotation * reflectVec );
		#ifdef ENVMAP_BLENDING_MULTIPLY
			outgoingLight = mix( outgoingLight, outgoingLight * envColor.xyz, specularStrength * reflectivity );
		#elif defined( ENVMAP_BLENDING_MIX )
			outgoingLight = mix( outgoingLight, envColor.xyz, specularStrength * reflectivity );
		#elif defined( ENVMAP_BLENDING_ADD )
			outgoingLight += envColor.xyz * specularStrength * reflectivity;
		#endif
	#endif
#endif`,HC=`#ifdef USE_ENVMAP
	uniform float envMapIntensity;
	uniform mat3 envMapRotation;
	#ifdef ENVMAP_TYPE_CUBE
		uniform samplerCube envMap;
	#else
		uniform sampler2D envMap;
	#endif
#endif`,VC=`#ifdef USE_ENVMAP
	uniform float reflectivity;
	#if defined( USE_BUMPMAP ) || defined( USE_NORMALMAP ) || defined( PHONG ) || defined( LAMBERT )
		#define ENV_WORLDPOS
	#endif
	#ifdef ENV_WORLDPOS
		varying vec3 vWorldPosition;
		uniform float refractionRatio;
	#else
		varying vec3 vReflect;
	#endif
#endif`,GC=`#ifdef USE_ENVMAP
	#if defined( USE_BUMPMAP ) || defined( USE_NORMALMAP ) || defined( PHONG ) || defined( LAMBERT )
		#define ENV_WORLDPOS
	#endif
	#ifdef ENV_WORLDPOS
		
		varying vec3 vWorldPosition;
	#else
		varying vec3 vReflect;
		uniform float refractionRatio;
	#endif
#endif`,qC=`#ifdef USE_ENVMAP
	#ifdef ENV_WORLDPOS
		vWorldPosition = worldPosition.xyz;
	#else
		vec3 cameraToVertex;
		if ( isOrthographic ) {
			cameraToVertex = normalize( vec3( - viewMatrix[ 0 ][ 2 ], - viewMatrix[ 1 ][ 2 ], - viewMatrix[ 2 ][ 2 ] ) );
		} else {
			cameraToVertex = normalize( worldPosition.xyz - cameraPosition );
		}
		vec3 worldNormal = transformNormalByInverseViewMatrix( transformedNormal, viewMatrix );
		#ifdef ENVMAP_MODE_REFLECTION
			vReflect = reflect( cameraToVertex, worldNormal );
		#else
			vReflect = refract( cameraToVertex, worldNormal, refractionRatio );
		#endif
	#endif
#endif`,WC=`#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
#endif`,XC=`#ifdef USE_FOG
	varying float vFogDepth;
#endif`,YC=`#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`,ZC=`#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`,KC=`#ifdef USE_GRADIENTMAP
	uniform sampler2D gradientMap;
#endif
vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
	float dotNL = dot( normal, lightDirection );
	vec2 coord = vec2( dotNL * 0.5 + 0.5, 0.0 );
	#ifdef USE_GRADIENTMAP
		return vec3( texture2D( gradientMap, coord ).r );
	#else
		vec2 fw = fwidth( coord ) * 0.5;
		return mix( vec3( 0.7 ), vec3( 1.0 ), smoothstep( 0.7 - fw.x, 0.7 + fw.x, coord.x ) );
	#endif
}`,JC=`#ifdef USE_LIGHTMAP
	uniform sampler2D lightMap;
	uniform float lightMapIntensity;
#endif`,QC=`LambertMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.specularStrength = specularStrength;`,jC=`varying vec3 vViewPosition;
struct LambertMaterial {
	vec3 diffuseColor;
	float specularStrength;
};
void RE_Direct_Lambert( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_Lambert
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Lambert`,$C=`uniform bool receiveShadow;
uniform vec3 ambientLightColor;
#if defined( USE_LIGHT_PROBES )
	uniform vec3 lightProbe[ 9 ];
#endif
vec3 shGetIrradianceAt( in vec3 normal, in vec3 shCoefficients[ 9 ] ) {
	float x = normal.x, y = normal.y, z = normal.z;
	vec3 result = shCoefficients[ 0 ] * 0.886227;
	result += shCoefficients[ 1 ] * 2.0 * 0.511664 * y;
	result += shCoefficients[ 2 ] * 2.0 * 0.511664 * z;
	result += shCoefficients[ 3 ] * 2.0 * 0.511664 * x;
	result += shCoefficients[ 4 ] * 2.0 * 0.429043 * x * y;
	result += shCoefficients[ 5 ] * 2.0 * 0.429043 * y * z;
	result += shCoefficients[ 6 ] * ( 0.743125 * z * z - 0.247708 );
	result += shCoefficients[ 7 ] * 2.0 * 0.429043 * x * z;
	result += shCoefficients[ 8 ] * 0.429043 * ( x * x - y * y );
	return result;
}
vec3 getLightProbeIrradiance( const in vec3 lightProbe[ 9 ], const in vec3 normal ) {
	vec3 worldNormal = transformNormalByInverseViewMatrix( normal, viewMatrix );
	vec3 irradiance = shGetIrradianceAt( worldNormal, lightProbe );
	return irradiance;
}
vec3 getAmbientLightIrradiance( const in vec3 ambientLightColor ) {
	vec3 irradiance = ambientLightColor;
	return irradiance;
}
float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {
	float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );
	if ( cutoffDistance > 0.0 ) {
		distanceFalloff *= pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) );
	}
	return distanceFalloff;
}
float getSpotAttenuation( const in float coneCosine, const in float penumbraCosine, const in float angleCosine ) {
	return smoothstep( coneCosine, penumbraCosine, angleCosine );
}
#if NUM_DIR_LIGHTS > 0
	struct DirectionalLight {
		vec3 direction;
		vec3 color;
	};
	uniform DirectionalLight directionalLights[ NUM_DIR_LIGHTS ];
	void getDirectionalLightInfo( const in DirectionalLight directionalLight, out IncidentLight light ) {
		light.color = directionalLight.color;
		light.direction = directionalLight.direction;
		light.visible = true;
	}
#endif
#if NUM_POINT_LIGHTS > 0
	struct PointLight {
		vec3 position;
		vec3 color;
		float distance;
		float decay;
	};
	uniform PointLight pointLights[ NUM_POINT_LIGHTS ];
	void getPointLightInfo( const in PointLight pointLight, const in vec3 geometryPosition, out IncidentLight light ) {
		vec3 lVector = pointLight.position - geometryPosition;
		light.direction = normalize( lVector );
		float lightDistance = length( lVector );
		light.color = pointLight.color;
		light.color *= getDistanceAttenuation( lightDistance, pointLight.distance, pointLight.decay );
		light.visible = ( light.color != vec3( 0.0 ) );
	}
#endif
#if NUM_SPOT_LIGHTS > 0
	struct SpotLight {
		vec3 position;
		vec3 direction;
		vec3 color;
		float distance;
		float decay;
		float coneCos;
		float penumbraCos;
	};
	uniform SpotLight spotLights[ NUM_SPOT_LIGHTS ];
	void getSpotLightInfo( const in SpotLight spotLight, const in vec3 geometryPosition, out IncidentLight light ) {
		vec3 lVector = spotLight.position - geometryPosition;
		light.direction = normalize( lVector );
		float angleCos = dot( light.direction, spotLight.direction );
		float spotAttenuation = getSpotAttenuation( spotLight.coneCos, spotLight.penumbraCos, angleCos );
		if ( spotAttenuation > 0.0 ) {
			float lightDistance = length( lVector );
			light.color = spotLight.color * spotAttenuation;
			light.color *= getDistanceAttenuation( lightDistance, spotLight.distance, spotLight.decay );
			light.visible = ( light.color != vec3( 0.0 ) );
		} else {
			light.color = vec3( 0.0 );
			light.visible = false;
		}
	}
#endif
#if NUM_RECT_AREA_LIGHTS > 0
	struct RectAreaLight {
		vec3 color;
		vec3 position;
		vec3 halfWidth;
		vec3 halfHeight;
	};
	uniform sampler2D ltc_1;	uniform sampler2D ltc_2;
	uniform RectAreaLight rectAreaLights[ NUM_RECT_AREA_LIGHTS ];
#endif
#if NUM_HEMI_LIGHTS > 0
	struct HemisphereLight {
		vec3 direction;
		vec3 skyColor;
		vec3 groundColor;
	};
	uniform HemisphereLight hemisphereLights[ NUM_HEMI_LIGHTS ];
	vec3 getHemisphereLightIrradiance( const in HemisphereLight hemiLight, const in vec3 normal ) {
		float dotNL = dot( normal, hemiLight.direction );
		float hemiDiffuseWeight = 0.5 * dotNL + 0.5;
		vec3 irradiance = mix( hemiLight.groundColor, hemiLight.skyColor, hemiDiffuseWeight );
		return irradiance;
	}
#endif
#include <lightprobes_pars_fragment>`,eL=`#ifdef USE_ENVMAP
	vec3 getIBLIrradiance( const in vec3 normal ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 worldNormal = transformNormalByInverseViewMatrix( normal, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, envMapRotation * worldNormal, 1.0 );
			return PI * envMapColor.rgb * envMapIntensity;
		#else
			return vec3( 0.0 );
		#endif
	}
	vec3 getIBLRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 reflectVec = reflect( - viewDir, normal );
			reflectVec = normalize( mix( reflectVec, normal, pow4( roughness ) ) );
			reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );
			return envMapColor.rgb * envMapIntensity;
		#else
			return vec3( 0.0 );
		#endif
	}
	#ifdef USE_ANISOTROPY
		vec3 getIBLAnisotropyRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in vec3 bitangent, const in float anisotropy ) {
			#ifdef ENVMAP_TYPE_CUBE_UV
				vec3 bentNormal = cross( bitangent, viewDir );
				bentNormal = normalize( cross( bentNormal, bitangent ) );
				bentNormal = normalize( mix( bentNormal, normal, pow2( pow2( 1.0 - anisotropy * ( 1.0 - roughness ) ) ) ) );
				return getIBLRadiance( viewDir, bentNormal, roughness );
			#else
				return vec3( 0.0 );
			#endif
		}
	#endif
#endif`,tL=`ToonMaterial material;
material.diffuseColor = diffuseColor.rgb;`,aL=`varying vec3 vViewPosition;
struct ToonMaterial {
	vec3 diffuseColor;
};
void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_Toon
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Toon`,nL=`BlinnPhongMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.specularColor = specular;
material.specularShininess = shininess;
material.specularStrength = specularStrength;`,iL=`varying vec3 vViewPosition;
struct BlinnPhongMaterial {
	vec3 diffuseColor;
	vec3 specularColor;
	float specularShininess;
	float specularStrength;
};
void RE_Direct_BlinnPhong( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
	reflectedLight.directSpecular += irradiance * BRDF_BlinnPhong( directLight.direction, geometryViewDir, geometryNormal, material.specularColor, material.specularShininess ) * material.specularStrength;
}
void RE_IndirectDiffuse_BlinnPhong( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_BlinnPhong
#define RE_IndirectDiffuse		RE_IndirectDiffuse_BlinnPhong`,sL=`PhysicalMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.diffuseContribution = diffuseColor.rgb * ( 1.0 - metalnessFactor );
material.metalness = metalnessFactor;
vec3 dxy = max( abs( dFdx( nonPerturbedNormal ) ), abs( dFdy( nonPerturbedNormal ) ) );
float geometryRoughness = max( max( dxy.x, dxy.y ), dxy.z );
material.roughness = max( roughnessFactor, 0.0525 );material.roughness += geometryRoughness;
material.roughness = min( material.roughness, 1.0 );
#ifdef IOR
	material.ior = ior;
	#ifdef USE_SPECULAR
		float specularIntensityFactor = specularIntensity;
		vec3 specularColorFactor = specularColor;
		#ifdef USE_SPECULAR_COLORMAP
			specularColorFactor *= texture2D( specularColorMap, vSpecularColorMapUv ).rgb;
		#endif
		#ifdef USE_SPECULAR_INTENSITYMAP
			specularIntensityFactor *= texture2D( specularIntensityMap, vSpecularIntensityMapUv ).a;
		#endif
		material.specularF90 = mix( specularIntensityFactor, 1.0, metalnessFactor );
	#else
		float specularIntensityFactor = 1.0;
		vec3 specularColorFactor = vec3( 1.0 );
		material.specularF90 = 1.0;
	#endif
	material.specularColor = min( pow2( ( material.ior - 1.0 ) / ( material.ior + 1.0 ) ) * specularColorFactor, vec3( 1.0 ) ) * specularIntensityFactor;
	material.specularColorBlended = mix( material.specularColor, diffuseColor.rgb, metalnessFactor );
#else
	material.specularColor = vec3( 0.04 );
	material.specularColorBlended = mix( material.specularColor, diffuseColor.rgb, metalnessFactor );
	material.specularF90 = 1.0;
#endif
#ifdef USE_CLEARCOAT
	material.clearcoat = clearcoat;
	material.clearcoatRoughness = clearcoatRoughness;
	material.clearcoatF0 = vec3( 0.04 );
	material.clearcoatF90 = 1.0;
	#ifdef USE_CLEARCOATMAP
		material.clearcoat *= texture2D( clearcoatMap, vClearcoatMapUv ).x;
	#endif
	#ifdef USE_CLEARCOAT_ROUGHNESSMAP
		material.clearcoatRoughness *= texture2D( clearcoatRoughnessMap, vClearcoatRoughnessMapUv ).y;
	#endif
	material.clearcoat = saturate( material.clearcoat );	material.clearcoatRoughness = max( material.clearcoatRoughness, 0.0525 );
	material.clearcoatRoughness += geometryRoughness;
	material.clearcoatRoughness = min( material.clearcoatRoughness, 1.0 );
#endif
#ifdef USE_DISPERSION
	material.dispersion = dispersion;
#endif
#ifdef USE_IRIDESCENCE
	material.iridescence = iridescence;
	material.iridescenceIOR = iridescenceIOR;
	#ifdef USE_IRIDESCENCEMAP
		material.iridescence *= texture2D( iridescenceMap, vIridescenceMapUv ).r;
	#endif
	#ifdef USE_IRIDESCENCE_THICKNESSMAP
		material.iridescenceThickness = (iridescenceThicknessMaximum - iridescenceThicknessMinimum) * texture2D( iridescenceThicknessMap, vIridescenceThicknessMapUv ).g + iridescenceThicknessMinimum;
	#else
		material.iridescenceThickness = iridescenceThicknessMaximum;
	#endif
#endif
#ifdef USE_SHEEN
	material.sheenColor = sheenColor;
	#ifdef USE_SHEEN_COLORMAP
		material.sheenColor *= texture2D( sheenColorMap, vSheenColorMapUv ).rgb;
	#endif
	material.sheenRoughness = clamp( sheenRoughness, 0.0001, 1.0 );
	#ifdef USE_SHEEN_ROUGHNESSMAP
		material.sheenRoughness *= texture2D( sheenRoughnessMap, vSheenRoughnessMapUv ).a;
	#endif
#endif
#ifdef USE_ANISOTROPY
	#ifdef USE_ANISOTROPYMAP
		mat2 anisotropyMat = mat2( anisotropyVector.x, anisotropyVector.y, - anisotropyVector.y, anisotropyVector.x );
		vec3 anisotropyPolar = texture2D( anisotropyMap, vAnisotropyMapUv ).rgb;
		vec2 anisotropyV = anisotropyMat * normalize( 2.0 * anisotropyPolar.rg - vec2( 1.0 ) ) * anisotropyPolar.b;
	#else
		vec2 anisotropyV = anisotropyVector;
	#endif
	material.anisotropy = length( anisotropyV );
	if( material.anisotropy == 0.0 ) {
		anisotropyV = vec2( 1.0, 0.0 );
	} else {
		anisotropyV /= material.anisotropy;
		material.anisotropy = saturate( material.anisotropy );
	}
	material.alphaT = mix( pow2( material.roughness ), 1.0, pow2( material.anisotropy ) );
	material.anisotropyT = tbn[ 0 ] * anisotropyV.x + tbn[ 1 ] * anisotropyV.y;
	material.anisotropyB = tbn[ 1 ] * anisotropyV.x - tbn[ 0 ] * anisotropyV.y;
#endif`,rL=`uniform sampler2D dfgLUT;
struct PhysicalMaterial {
	vec3 diffuseColor;
	vec3 diffuseContribution;
	vec3 specularColor;
	vec3 specularColorBlended;
	float roughness;
	float metalness;
	float specularF90;
	float dispersion;
	#ifdef USE_CLEARCOAT
		float clearcoat;
		float clearcoatRoughness;
		vec3 clearcoatF0;
		float clearcoatF90;
	#endif
	#ifdef USE_IRIDESCENCE
		float iridescence;
		float iridescenceIOR;
		float iridescenceThickness;
		vec3 iridescenceFresnel;
		vec3 iridescenceF0;
		vec3 iridescenceFresnelDielectric;
		vec3 iridescenceFresnelMetallic;
	#endif
	#ifdef USE_SHEEN
		vec3 sheenColor;
		float sheenRoughness;
	#endif
	#ifdef IOR
		float ior;
	#endif
	#ifdef USE_TRANSMISSION
		float transmission;
		float transmissionAlpha;
		float thickness;
		float attenuationDistance;
		vec3 attenuationColor;
	#endif
	#ifdef USE_ANISOTROPY
		float anisotropy;
		float alphaT;
		vec3 anisotropyT;
		vec3 anisotropyB;
	#endif
};
vec3 clearcoatSpecularDirect = vec3( 0.0 );
vec3 clearcoatSpecularIndirect = vec3( 0.0 );
vec3 sheenSpecularDirect = vec3( 0.0 );
vec3 sheenSpecularIndirect = vec3(0.0 );
vec3 Schlick_to_F0( const in vec3 f, const in float f90, const in float dotVH ) {
    float x = clamp( 1.0 - dotVH, 0.0, 1.0 );
    float x2 = x * x;
    float x5 = clamp( x * x2 * x2, 0.0, 0.9999 );
    return ( f - vec3( f90 ) * x5 ) / ( 1.0 - x5 );
}
float V_GGX_SmithCorrelated( const in float alpha, const in float dotNL, const in float dotNV ) {
	float a2 = pow2( alpha );
	float gv = dotNL * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNV ) );
	float gl = dotNV * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNL ) );
	return 0.5 / max( gv + gl, EPSILON );
}
float D_GGX( const in float alpha, const in float dotNH ) {
	float a2 = pow2( alpha );
	float denom = pow2( dotNH ) * ( a2 - 1.0 ) + 1.0;
	return RECIPROCAL_PI * a2 / pow2( denom );
}
#ifdef USE_ANISOTROPY
	float V_GGX_SmithCorrelated_Anisotropic( const in float alphaT, const in float alphaB, const in float dotTV, const in float dotBV, const in float dotTL, const in float dotBL, const in float dotNV, const in float dotNL ) {
		float gv = dotNL * length( vec3( alphaT * dotTV, alphaB * dotBV, dotNV ) );
		float gl = dotNV * length( vec3( alphaT * dotTL, alphaB * dotBL, dotNL ) );
		return 0.5 / max( gv + gl, EPSILON );
	}
	float D_GGX_Anisotropic( const in float alphaT, const in float alphaB, const in float dotNH, const in float dotTH, const in float dotBH ) {
		float a2 = alphaT * alphaB;
		highp vec3 v = vec3( alphaB * dotTH, alphaT * dotBH, a2 * dotNH );
		highp float v2 = dot( v, v );
		float w2 = a2 / v2;
		return RECIPROCAL_PI * a2 * pow2 ( w2 );
	}
#endif
#ifdef USE_CLEARCOAT
	vec3 BRDF_GGX_Clearcoat( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material) {
		vec3 f0 = material.clearcoatF0;
		float f90 = material.clearcoatF90;
		float roughness = material.clearcoatRoughness;
		float alpha = pow2( roughness );
		vec3 halfDir = normalize( lightDir + viewDir );
		float dotNL = saturate( dot( normal, lightDir ) );
		float dotNV = saturate( dot( normal, viewDir ) );
		float dotNH = saturate( dot( normal, halfDir ) );
		float dotVH = saturate( dot( viewDir, halfDir ) );
		vec3 F = F_Schlick( f0, f90, dotVH );
		float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
		float D = D_GGX( alpha, dotNH );
		return F * ( V * D );
	}
#endif
vec3 BRDF_GGX( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material ) {
	vec3 f0 = material.specularColorBlended;
	float f90 = material.specularF90;
	float roughness = material.roughness;
	float alpha = pow2( roughness );
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( f0, f90, dotVH );
	#ifdef USE_IRIDESCENCE
		F = mix( F, material.iridescenceFresnel, material.iridescence );
	#endif
	#ifdef USE_ANISOTROPY
		float dotTL = dot( material.anisotropyT, lightDir );
		float dotTV = dot( material.anisotropyT, viewDir );
		float dotTH = dot( material.anisotropyT, halfDir );
		float dotBL = dot( material.anisotropyB, lightDir );
		float dotBV = dot( material.anisotropyB, viewDir );
		float dotBH = dot( material.anisotropyB, halfDir );
		float V = V_GGX_SmithCorrelated_Anisotropic( material.alphaT, alpha, dotTV, dotBV, dotTL, dotBL, dotNV, dotNL );
		float D = D_GGX_Anisotropic( material.alphaT, alpha, dotNH, dotTH, dotBH );
	#else
		float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
		float D = D_GGX( alpha, dotNH );
	#endif
	return F * ( V * D );
}
vec2 LTC_Uv( const in vec3 N, const in vec3 V, const in float roughness ) {
	const float LUT_SIZE = 64.0;
	const float LUT_SCALE = ( LUT_SIZE - 1.0 ) / LUT_SIZE;
	const float LUT_BIAS = 0.5 / LUT_SIZE;
	float dotNV = saturate( dot( N, V ) );
	vec2 uv = vec2( roughness, sqrt( 1.0 - dotNV ) );
	uv = uv * LUT_SCALE + LUT_BIAS;
	return uv;
}
float LTC_ClippedSphereFormFactor( const in vec3 f ) {
	float l = length( f );
	return max( ( l * l + f.z ) / ( l + 1.0 ), 0.0 );
}
vec3 LTC_EdgeVectorFormFactor( const in vec3 v1, const in vec3 v2 ) {
	float x = dot( v1, v2 );
	float y = abs( x );
	float a = 0.8543985 + ( 0.4965155 + 0.0145206 * y ) * y;
	float b = 3.4175940 + ( 4.1616724 + y ) * y;
	float v = a / b;
	float theta_sintheta = ( x > 0.0 ) ? v : 0.5 * inversesqrt( max( 1.0 - x * x, 1e-7 ) ) - v;
	return cross( v1, v2 ) * theta_sintheta;
}
vec3 LTC_Evaluate( const in vec3 N, const in vec3 V, const in vec3 P, const in mat3 mInv, const in vec3 rectCoords[ 4 ] ) {
	vec3 v1 = rectCoords[ 1 ] - rectCoords[ 0 ];
	vec3 v2 = rectCoords[ 3 ] - rectCoords[ 0 ];
	vec3 lightNormal = cross( v1, v2 );
	if( dot( lightNormal, P - rectCoords[ 0 ] ) < 0.0 ) return vec3( 0.0 );
	vec3 T1, T2;
	T1 = normalize( V - N * dot( V, N ) );
	T2 = - cross( N, T1 );
	mat3 mat = mInv * transpose( mat3( T1, T2, N ) );
	vec3 coords[ 4 ];
	coords[ 0 ] = mat * ( rectCoords[ 0 ] - P );
	coords[ 1 ] = mat * ( rectCoords[ 1 ] - P );
	coords[ 2 ] = mat * ( rectCoords[ 2 ] - P );
	coords[ 3 ] = mat * ( rectCoords[ 3 ] - P );
	coords[ 0 ] = normalize( coords[ 0 ] );
	coords[ 1 ] = normalize( coords[ 1 ] );
	coords[ 2 ] = normalize( coords[ 2 ] );
	coords[ 3 ] = normalize( coords[ 3 ] );
	vec3 vectorFormFactor = vec3( 0.0 );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 0 ], coords[ 1 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 1 ], coords[ 2 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 2 ], coords[ 3 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 3 ], coords[ 0 ] );
	float result = LTC_ClippedSphereFormFactor( vectorFormFactor );
	return vec3( result );
}
#if defined( USE_SHEEN )
float D_Charlie( float roughness, float dotNH ) {
	float alpha = pow2( roughness );
	float invAlpha = 1.0 / alpha;
	float cos2h = dotNH * dotNH;
	float sin2h = max( 1.0 - cos2h, 0.0078125 );
	return ( 2.0 + invAlpha ) * pow( sin2h, invAlpha * 0.5 ) / ( 2.0 * PI );
}
float V_Neubelt( float dotNV, float dotNL ) {
	return saturate( 1.0 / ( 4.0 * ( dotNL + dotNV - dotNL * dotNV ) ) );
}
vec3 BRDF_Sheen( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, vec3 sheenColor, const in float sheenRoughness ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float D = D_Charlie( sheenRoughness, dotNH );
	float V = V_Neubelt( dotNV, dotNL );
	return sheenColor * ( D * V );
}
#endif
float IBLSheenBRDF( const in vec3 normal, const in vec3 viewDir, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	float r2 = roughness * roughness;
	float rInv = 1.0 / ( roughness + 0.1 );
	float a = -1.9362 + 1.0678 * roughness + 0.4573 * r2 - 0.8469 * rInv;
	float b = -0.6014 + 0.5538 * roughness - 0.4670 * r2 - 0.1255 * rInv;
	float DG = exp( a * dotNV + b );
	return saturate( DG );
}
vec3 EnvironmentBRDF( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	vec2 fab = texture2D( dfgLUT, vec2( roughness, dotNV ) ).rg;
	return specularColor * fab.x + specularF90 * fab.y;
}
#ifdef USE_IRIDESCENCE
void computeMultiscatteringIridescence( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float iridescence, const in vec3 iridescenceF0, const in float roughness, inout vec3 singleScatter, inout vec3 multiScatter ) {
#else
void computeMultiscattering( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float roughness, inout vec3 singleScatter, inout vec3 multiScatter ) {
#endif
	float dotNV = saturate( dot( normal, viewDir ) );
	vec2 fab = texture2D( dfgLUT, vec2( roughness, dotNV ) ).rg;
	#ifdef USE_IRIDESCENCE
		vec3 Fr = mix( specularColor, iridescenceF0, iridescence );
	#else
		vec3 Fr = specularColor;
	#endif
	vec3 FssEss = Fr * fab.x + specularF90 * fab.y;
	float Ess = fab.x + fab.y;
	float Ems = 1.0 - Ess;
	vec3 Favg = Fr + ( 1.0 - Fr ) * 0.047619;	vec3 Fms = FssEss * Favg / ( 1.0 - Ems * Favg );
	singleScatter += FssEss;
	multiScatter += Fms * Ems;
}
vec3 BRDF_GGX_Multiscatter( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material ) {
	vec3 singleScatter = BRDF_GGX( lightDir, viewDir, normal, material );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	vec2 dfgV = texture2D( dfgLUT, vec2( material.roughness, dotNV ) ).rg;
	vec2 dfgL = texture2D( dfgLUT, vec2( material.roughness, dotNL ) ).rg;
	vec3 FssEss_V = material.specularColorBlended * dfgV.x + material.specularF90 * dfgV.y;
	vec3 FssEss_L = material.specularColorBlended * dfgL.x + material.specularF90 * dfgL.y;
	float Ess_V = dfgV.x + dfgV.y;
	float Ess_L = dfgL.x + dfgL.y;
	float Ems_V = 1.0 - Ess_V;
	float Ems_L = 1.0 - Ess_L;
	vec3 Favg = material.specularColorBlended + ( 1.0 - material.specularColorBlended ) * 0.047619;
	vec3 Fms = FssEss_V * FssEss_L * Favg / ( 1.0 - Ems_V * Ems_L * Favg + EPSILON );
	float compensationFactor = Ems_V * Ems_L;
	vec3 multiScatter = Fms * compensationFactor;
	return singleScatter + multiScatter;
}
#if NUM_RECT_AREA_LIGHTS > 0
	void RE_Direct_RectArea_Physical( const in RectAreaLight rectAreaLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
		vec3 normal = geometryNormal;
		vec3 viewDir = geometryViewDir;
		vec3 position = geometryPosition;
		vec3 lightPos = rectAreaLight.position;
		vec3 halfWidth = rectAreaLight.halfWidth;
		vec3 halfHeight = rectAreaLight.halfHeight;
		vec3 lightColor = rectAreaLight.color;
		float roughness = material.roughness;
		vec3 rectCoords[ 4 ];
		rectCoords[ 0 ] = lightPos + halfWidth - halfHeight;		rectCoords[ 1 ] = lightPos - halfWidth - halfHeight;
		rectCoords[ 2 ] = lightPos - halfWidth + halfHeight;
		rectCoords[ 3 ] = lightPos + halfWidth + halfHeight;
		vec2 uv = LTC_Uv( normal, viewDir, roughness );
		vec4 t1 = texture2D( ltc_1, uv );
		vec4 t2 = texture2D( ltc_2, uv );
		mat3 mInv = mat3(
			vec3( t1.x, 0, t1.y ),
			vec3(    0, 1,    0 ),
			vec3( t1.z, 0, t1.w )
		);
		vec3 fresnel = ( material.specularColorBlended * t2.x + ( material.specularF90 - material.specularColorBlended ) * t2.y );
		reflectedLight.directSpecular += lightColor * fresnel * LTC_Evaluate( normal, viewDir, position, mInv, rectCoords );
		reflectedLight.directDiffuse += lightColor * material.diffuseContribution * LTC_Evaluate( normal, viewDir, position, mat3( 1.0 ), rectCoords );
		#ifdef USE_CLEARCOAT
			vec3 Ncc = geometryClearcoatNormal;
			vec2 uvClearcoat = LTC_Uv( Ncc, viewDir, material.clearcoatRoughness );
			vec4 t1Clearcoat = texture2D( ltc_1, uvClearcoat );
			vec4 t2Clearcoat = texture2D( ltc_2, uvClearcoat );
			mat3 mInvClearcoat = mat3(
				vec3( t1Clearcoat.x, 0, t1Clearcoat.y ),
				vec3(             0, 1,             0 ),
				vec3( t1Clearcoat.z, 0, t1Clearcoat.w )
			);
			vec3 fresnelClearcoat = material.clearcoatF0 * t2Clearcoat.x + ( material.clearcoatF90 - material.clearcoatF0 ) * t2Clearcoat.y;
			clearcoatSpecularDirect += lightColor * fresnelClearcoat * LTC_Evaluate( Ncc, viewDir, position, mInvClearcoat, rectCoords );
		#endif
	}
#endif
void RE_Direct_Physical( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	#ifdef USE_CLEARCOAT
		float dotNLcc = saturate( dot( geometryClearcoatNormal, directLight.direction ) );
		vec3 ccIrradiance = dotNLcc * directLight.color;
		clearcoatSpecularDirect += ccIrradiance * BRDF_GGX_Clearcoat( directLight.direction, geometryViewDir, geometryClearcoatNormal, material );
	#endif
	#ifdef USE_SHEEN
 
 		sheenSpecularDirect += irradiance * BRDF_Sheen( directLight.direction, geometryViewDir, geometryNormal, material.sheenColor, material.sheenRoughness );
 
 		float sheenAlbedoV = IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness );
 		float sheenAlbedoL = IBLSheenBRDF( geometryNormal, directLight.direction, material.sheenRoughness );
 
 		float sheenEnergyComp = 1.0 - max3( material.sheenColor ) * max( sheenAlbedoV, sheenAlbedoL );
 
 		irradiance *= sheenEnergyComp;
 
 	#endif
	reflectedLight.directSpecular += irradiance * BRDF_GGX_Multiscatter( directLight.direction, geometryViewDir, geometryNormal, material );
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );
}
void RE_IndirectDiffuse_Physical( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	vec3 diffuse = irradiance * BRDF_Lambert( material.diffuseContribution );
	#ifdef USE_SHEEN
		float sheenAlbedo = IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness );
		float sheenEnergyComp = 1.0 - max3( material.sheenColor ) * sheenAlbedo;
		diffuse *= sheenEnergyComp;
	#endif
	reflectedLight.indirectDiffuse += diffuse;
}
void RE_IndirectSpecular_Physical( const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
	#ifdef USE_CLEARCOAT
		clearcoatSpecularIndirect += clearcoatRadiance * EnvironmentBRDF( geometryClearcoatNormal, geometryViewDir, material.clearcoatF0, material.clearcoatF90, material.clearcoatRoughness );
	#endif
	#ifdef USE_SHEEN
		sheenSpecularIndirect += irradiance * material.sheenColor * IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness ) * RECIPROCAL_PI;
 	#endif
	vec3 singleScatteringDielectric = vec3( 0.0 );
	vec3 multiScatteringDielectric = vec3( 0.0 );
	vec3 singleScatteringMetallic = vec3( 0.0 );
	vec3 multiScatteringMetallic = vec3( 0.0 );
	#ifdef USE_IRIDESCENCE
		computeMultiscatteringIridescence( geometryNormal, geometryViewDir, material.specularColor, material.specularF90, material.iridescence, material.iridescenceFresnelDielectric, material.roughness, singleScatteringDielectric, multiScatteringDielectric );
		computeMultiscatteringIridescence( geometryNormal, geometryViewDir, material.diffuseColor, material.specularF90, material.iridescence, material.iridescenceFresnelMetallic, material.roughness, singleScatteringMetallic, multiScatteringMetallic );
	#else
		computeMultiscattering( geometryNormal, geometryViewDir, material.specularColor, material.specularF90, material.roughness, singleScatteringDielectric, multiScatteringDielectric );
		computeMultiscattering( geometryNormal, geometryViewDir, material.diffuseColor, material.specularF90, material.roughness, singleScatteringMetallic, multiScatteringMetallic );
	#endif
	vec3 singleScattering = mix( singleScatteringDielectric, singleScatteringMetallic, material.metalness );
	vec3 multiScattering = mix( multiScatteringDielectric, multiScatteringMetallic, material.metalness );
	vec3 totalScatteringDielectric = singleScatteringDielectric + multiScatteringDielectric;
	vec3 diffuse = material.diffuseContribution * ( 1.0 - totalScatteringDielectric );
	vec3 cosineWeightedIrradiance = irradiance * RECIPROCAL_PI;
	vec3 indirectSpecular = radiance * singleScattering;
	indirectSpecular += multiScattering * cosineWeightedIrradiance;
	vec3 indirectDiffuse = diffuse * cosineWeightedIrradiance;
	#ifdef USE_SHEEN
		float sheenAlbedo = IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness );
		float sheenEnergyComp = 1.0 - max3( material.sheenColor ) * sheenAlbedo;
		indirectSpecular *= sheenEnergyComp;
		indirectDiffuse *= sheenEnergyComp;
	#endif
	reflectedLight.indirectSpecular += indirectSpecular;
	reflectedLight.indirectDiffuse += indirectDiffuse;
}
#define RE_Direct				RE_Direct_Physical
#define RE_Direct_RectArea		RE_Direct_RectArea_Physical
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Physical
#define RE_IndirectSpecular		RE_IndirectSpecular_Physical
float computeSpecularOcclusion( const in float dotNV, const in float ambientOcclusion, const in float roughness ) {
	return saturate( pow( dotNV + ambientOcclusion, exp2( - 16.0 * roughness - 1.0 ) ) - 1.0 + ambientOcclusion );
}`,oL=`
vec3 geometryPosition = - vViewPosition;
vec3 geometryNormal = normal;
vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );
vec3 geometryClearcoatNormal = vec3( 0.0 );
#ifdef USE_CLEARCOAT
	geometryClearcoatNormal = clearcoatNormal;
#endif
#ifdef USE_IRIDESCENCE
	float dotNVi = saturate( dot( normal, geometryViewDir ) );
	if ( material.iridescenceThickness == 0.0 ) {
		material.iridescence = 0.0;
	} else {
		material.iridescence = saturate( material.iridescence );
	}
	if ( material.iridescence > 0.0 ) {
		material.iridescenceFresnelDielectric = evalIridescence( 1.0, material.iridescenceIOR, dotNVi, material.iridescenceThickness, material.specularColor );
		material.iridescenceFresnelMetallic = evalIridescence( 1.0, material.iridescenceIOR, dotNVi, material.iridescenceThickness, material.diffuseColor );
		material.iridescenceFresnel = mix( material.iridescenceFresnelDielectric, material.iridescenceFresnelMetallic, material.metalness );
		material.iridescenceF0 = Schlick_to_F0( material.iridescenceFresnel, 1.0, dotNVi );
	}
#endif
IncidentLight directLight;
#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )
	PointLight pointLight;
	#if defined( USE_SHADOWMAP ) && NUM_POINT_LIGHT_SHADOWS > 0
	PointLightShadow pointLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
		pointLight = pointLights[ i ];
		getPointLightInfo( pointLight, geometryPosition, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_POINT_LIGHT_SHADOWS ) && ( defined( SHADOWMAP_TYPE_PCF ) || defined( SHADOWMAP_TYPE_BASIC ) )
		pointLightShadow = pointLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getPointShadow( pointShadowMap[ i ], pointLightShadow.shadowMapSize, pointLightShadow.shadowIntensity, pointLightShadow.shadowBias, pointLightShadow.shadowRadius, vPointShadowCoord[ i ], pointLightShadow.shadowCameraNear, pointLightShadow.shadowCameraFar ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )
	SpotLight spotLight;
	vec4 spotColor;
	vec3 spotLightCoord;
	bool inSpotLightMap;
	#if defined( USE_SHADOWMAP ) && NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
		spotLight = spotLights[ i ];
		getSpotLightInfo( spotLight, geometryPosition, directLight );
		#if ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#define SPOT_LIGHT_MAP_INDEX UNROLLED_LOOP_INDEX
		#elif ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		#define SPOT_LIGHT_MAP_INDEX NUM_SPOT_LIGHT_MAPS
		#else
		#define SPOT_LIGHT_MAP_INDEX ( UNROLLED_LOOP_INDEX - NUM_SPOT_LIGHT_SHADOWS + NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#endif
		#if ( SPOT_LIGHT_MAP_INDEX < NUM_SPOT_LIGHT_MAPS )
			spotLightCoord = vSpotLightCoord[ i ].xyz / vSpotLightCoord[ i ].w;
			inSpotLightMap = all( lessThan( abs( spotLightCoord * 2. - 1. ), vec3( 1.0 ) ) );
			spotColor = texture2D( spotLightMap[ SPOT_LIGHT_MAP_INDEX ], spotLightCoord.xy );
			directLight.color = inSpotLightMap ? directLight.color * spotColor.rgb : directLight.color;
		#endif
		#undef SPOT_LIGHT_MAP_INDEX
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		spotLightShadow = spotLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowIntensity, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )
	RectAreaLight rectAreaLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_RECT_AREA_LIGHTS; i ++ ) {
		rectAreaLight = rectAreaLights[ i ];
		RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if defined( RE_IndirectDiffuse )
	vec3 iblIrradiance = vec3( 0.0 );
	vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );
	#if defined( USE_LIGHT_PROBES )
		irradiance += getLightProbeIrradiance( lightProbe, geometryNormal );
	#endif
	#if ( NUM_HEMI_LIGHTS > 0 )
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
			irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );
		}
		#pragma unroll_loop_end
	#endif
	#ifdef USE_LIGHT_PROBES_GRID
		vec3 probeWorldPos = ( ( vec4( geometryPosition, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
		vec3 probeWorldNormal = transformNormalByInverseViewMatrix( geometryNormal, viewMatrix );
		irradiance += getLightProbeGridIrradiance( probeWorldPos, probeWorldNormal );
	#endif
#endif
#if defined( RE_IndirectSpecular )
	vec3 radiance = vec3( 0.0 );
	vec3 clearcoatRadiance = vec3( 0.0 );
#endif`,lL=`#if defined( RE_IndirectDiffuse )
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;
		irradiance += lightMapIrradiance;
	#endif
	#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
		#if defined( STANDARD ) || defined( LAMBERT ) || defined( PHONG )
			iblIrradiance += getIBLIrradiance( geometryNormal );
		#endif
	#endif
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
	#ifdef USE_ANISOTROPY
		radiance += getIBLAnisotropyRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );
	#else
		radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
	#endif
	#ifdef USE_CLEARCOAT
		clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );
	#endif
#endif`,uL=`#if defined( RE_IndirectDiffuse )
	#if defined( LAMBERT ) || defined( PHONG )
		irradiance += iblIrradiance;
	#endif
	RE_IndirectDiffuse( irradiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif
#if defined( RE_IndirectSpecular )
	RE_IndirectSpecular( radiance, iblIrradiance, clearcoatRadiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif`,cL=`#ifdef USE_LIGHT_PROBES_GRID
uniform highp sampler3D probesSH;
uniform vec3 probesMin;
uniform vec3 probesMax;
uniform vec3 probesResolution;
vec3 getLightProbeGridIrradiance( vec3 worldPos, vec3 worldNormal ) {
	vec3 res = probesResolution;
	vec3 gridRange = probesMax - probesMin;
	vec3 resMinusOne = res - 1.0;
	vec3 probeSpacing = gridRange / resMinusOne;
	vec3 samplePos = worldPos + worldNormal * probeSpacing * 0.5;
	vec3 uvw = clamp( ( samplePos - probesMin ) / gridRange, 0.0, 1.0 );
	uvw = uvw * resMinusOne / res + 0.5 / res;
	float nz          = res.z;
	float paddedSlices = nz + 2.0;
	float atlasDepth  = 7.0 * paddedSlices;
	float uvZBase     = uvw.z * nz + 1.0;
	vec4 s0 = texture( probesSH, vec3( uvw.xy, ( uvZBase                       ) / atlasDepth ) );
	vec4 s1 = texture( probesSH, vec3( uvw.xy, ( uvZBase +       paddedSlices   ) / atlasDepth ) );
	vec4 s2 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 2.0 * paddedSlices   ) / atlasDepth ) );
	vec4 s3 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 3.0 * paddedSlices   ) / atlasDepth ) );
	vec4 s4 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 4.0 * paddedSlices   ) / atlasDepth ) );
	vec4 s5 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 5.0 * paddedSlices   ) / atlasDepth ) );
	vec4 s6 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 6.0 * paddedSlices   ) / atlasDepth ) );
	vec3 c0 = s0.xyz;
	vec3 c1 = vec3( s0.w, s1.xy );
	vec3 c2 = vec3( s1.zw, s2.x );
	vec3 c3 = s2.yzw;
	vec3 c4 = s3.xyz;
	vec3 c5 = vec3( s3.w, s4.xy );
	vec3 c6 = vec3( s4.zw, s5.x );
	vec3 c7 = s5.yzw;
	vec3 c8 = s6.xyz;
	float x = worldNormal.x, y = worldNormal.y, z = worldNormal.z;
	vec3 result = c0 * 0.886227;
	result += c1 * 2.0 * 0.511664 * y;
	result += c2 * 2.0 * 0.511664 * z;
	result += c3 * 2.0 * 0.511664 * x;
	result += c4 * 2.0 * 0.429043 * x * y;
	result += c5 * 2.0 * 0.429043 * y * z;
	result += c6 * ( 0.743125 * z * z - 0.247708 );
	result += c7 * 2.0 * 0.429043 * x * z;
	result += c8 * 0.429043 * ( x * x - y * y );
	return max( result, vec3( 0.0 ) );
}
#endif`,fL=`#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
	gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( vFragDepth ) * logDepthBufFC * 0.5;
#endif`,dL=`#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
	uniform float logDepthBufFC;
	varying float vFragDepth;
	varying float vIsPerspective;
#endif`,hL=`#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
	varying float vFragDepth;
	varying float vIsPerspective;
#endif`,pL=`#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
	vFragDepth = 1.0 + gl_Position.w;
	vIsPerspective = float( isPerspectiveMatrix( projectionMatrix ) );
#endif`,mL=`#ifdef USE_MAP
	vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	#ifdef DECODE_VIDEO_TEXTURE
		sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );
	#endif
	diffuseColor *= sampledDiffuseColor;
#endif`,gL=`#ifdef USE_MAP
	uniform sampler2D map;
#endif`,xL=`#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
	#if defined( USE_POINTS_UV )
		vec2 uv = vUv;
	#else
		vec2 uv = ( uvTransform * vec3( gl_PointCoord.x, 1.0 - gl_PointCoord.y, 1 ) ).xy;
	#endif
#endif
#ifdef USE_MAP
	diffuseColor *= texture2D( map, uv );
#endif
#ifdef USE_ALPHAMAP
	diffuseColor.a *= texture2D( alphaMap, uv ).g;
#endif`,vL=`#if defined( USE_POINTS_UV )
	varying vec2 vUv;
#else
	#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
		uniform mat3 uvTransform;
	#endif
#endif
#ifdef USE_MAP
	uniform sampler2D map;
#endif
#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,yL=`float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
	vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );
	metalnessFactor *= texelMetalness.b;
#endif`,_L=`#ifdef USE_METALNESSMAP
	uniform sampler2D metalnessMap;
#endif`,SL=`#ifdef USE_INSTANCING_MORPH
	float morphTargetInfluences[ MORPHTARGETS_COUNT ];
	float morphTargetBaseInfluence = texelFetch( morphTexture, ivec2( 0, gl_InstanceID ), 0 ).r;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		morphTargetInfluences[i] =  texelFetch( morphTexture, ivec2( i + 1, gl_InstanceID ), 0 ).r;
	}
#endif`,ML=`#if defined( USE_MORPHCOLORS )
	vColor *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		#if defined( USE_COLOR_ALPHA )
			if ( morphTargetInfluences[ i ] != 0.0 ) vColor += getMorph( gl_VertexID, i, 2 ) * morphTargetInfluences[ i ];
		#elif defined( USE_COLOR )
			if ( morphTargetInfluences[ i ] != 0.0 ) vColor += getMorph( gl_VertexID, i, 2 ).rgb * morphTargetInfluences[ i ];
		#endif
	}
#endif`,bL=`#ifdef USE_MORPHNORMALS
	objectNormal *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		if ( morphTargetInfluences[ i ] != 0.0 ) objectNormal += getMorph( gl_VertexID, i, 1 ).xyz * morphTargetInfluences[ i ];
	}
#endif`,CL=`#ifdef USE_MORPHTARGETS
	#ifndef USE_INSTANCING_MORPH
		uniform float morphTargetBaseInfluence;
		uniform float morphTargetInfluences[ MORPHTARGETS_COUNT ];
	#endif
	uniform sampler2DArray morphTargetsTexture;
	uniform ivec2 morphTargetsTextureSize;
	vec4 getMorph( const in int vertexIndex, const in int morphTargetIndex, const in int offset ) {
		int texelIndex = vertexIndex * MORPHTARGETS_TEXTURE_STRIDE + offset;
		int y = texelIndex / morphTargetsTextureSize.x;
		int x = texelIndex - y * morphTargetsTextureSize.x;
		ivec3 morphUV = ivec3( x, y, morphTargetIndex );
		return texelFetch( morphTargetsTexture, morphUV, 0 );
	}
#endif`,LL=`#ifdef USE_MORPHTARGETS
	transformed *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		if ( morphTargetInfluences[ i ] != 0.0 ) transformed += getMorph( gl_VertexID, i, 0 ).xyz * morphTargetInfluences[ i ];
	}
#endif`,AL=`float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
#ifdef FLAT_SHADED
	vec3 fdx = dFdx( vViewPosition );
	vec3 fdy = dFdy( vViewPosition );
	vec3 normal = normalize( cross( fdx, fdy ) );
#else
	vec3 normal = normalize( vNormal );
	#ifdef DOUBLE_SIDED
		normal *= faceDirection;
	#endif
#endif
#if defined( USE_NORMALMAP_TANGENTSPACE ) || defined( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY )
	#ifdef USE_TANGENT
		mat3 tbn = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn = getTangentFrame( - vViewPosition, normal,
		#if defined( USE_NORMALMAP )
			vNormalMapUv
		#elif defined( USE_CLEARCOAT_NORMALMAP )
			vClearcoatNormalMapUv
		#else
			vUv
		#endif
		);
	#endif
	#ifdef DOUBLE_SIDED
		tbn[0] *= faceDirection;
		tbn[1] *= faceDirection;
	#endif
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	#ifdef USE_TANGENT
		mat3 tbn2 = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn2 = getTangentFrame( - vViewPosition, normal, vClearcoatNormalMapUv );
	#endif
	#ifdef DOUBLE_SIDED
		tbn2[0] *= faceDirection;
		tbn2[1] *= faceDirection;
	#endif
#endif
vec3 nonPerturbedNormal = normal;`,TL=`#ifdef USE_NORMALMAP_OBJECTSPACE
	normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	#ifdef FLIP_SIDED
		normal = - normal;
	#endif
	#ifdef DOUBLE_SIDED
		normal = normal * faceDirection;
	#endif
	normal = normalize( normalMatrix * normal );
#elif defined( USE_NORMALMAP_TANGENTSPACE )
	vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	#if defined( USE_PACKED_NORMALMAP )
		mapN = vec3( mapN.xy, sqrt( saturate( 1.0 - dot( mapN.xy, mapN.xy ) ) ) );
	#endif
	mapN.xy *= normalScale;
	normal = normalize( tbn * mapN );
#elif defined( USE_BUMPMAP )
	normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
#endif`,IL=`#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif`,EL=`#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif`,wL=`#ifndef FLAT_SHADED
	vNormal = normalize( transformedNormal );
	#ifdef USE_TANGENT
		vTangent = normalize( transformedTangent );
		vBitangent = normalize( cross( vNormal, vTangent ) * tangent.w );
		#ifdef FLIP_SIDED
			vBitangent = - vBitangent;
		#endif
	#endif
#endif`,RL=`#ifdef USE_NORMALMAP
	uniform sampler2D normalMap;
	uniform vec2 normalScale;
#endif
#ifdef USE_NORMALMAP_OBJECTSPACE
	uniform mat3 normalMatrix;
#endif
#if ! defined ( USE_TANGENT ) && ( defined ( USE_NORMALMAP_TANGENTSPACE ) || defined ( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY ) )
	mat3 getTangentFrame( vec3 eye_pos, vec3 surf_norm, vec2 uv ) {
		vec3 q0 = dFdx( eye_pos.xyz );
		vec3 q1 = dFdy( eye_pos.xyz );
		vec2 st0 = dFdx( uv.st );
		vec2 st1 = dFdy( uv.st );
		vec3 N = surf_norm;
		vec3 q1perp = cross( q1, N );
		vec3 q0perp = cross( N, q0 );
		vec3 T = q1perp * st0.x + q0perp * st1.x;
		vec3 B = q1perp * st0.y + q0perp * st1.y;
		float det = max( dot( T, T ), dot( B, B ) );
		float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
		return mat3( T * scale, B * scale, N );
	}
#endif`,DL=`#ifdef USE_CLEARCOAT
	vec3 clearcoatNormal = nonPerturbedNormal;
#endif`,PL=`#ifdef USE_CLEARCOAT_NORMALMAP
	vec3 clearcoatMapN = texture2D( clearcoatNormalMap, vClearcoatNormalMapUv ).xyz * 2.0 - 1.0;
	clearcoatMapN.xy *= clearcoatNormalScale;
	clearcoatNormal = normalize( tbn2 * clearcoatMapN );
#endif`,UL=`#ifdef USE_CLEARCOATMAP
	uniform sampler2D clearcoatMap;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	uniform sampler2D clearcoatNormalMap;
	uniform vec2 clearcoatNormalScale;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	uniform sampler2D clearcoatRoughnessMap;
#endif`,BL=`#ifdef USE_IRIDESCENCEMAP
	uniform sampler2D iridescenceMap;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	uniform sampler2D iridescenceThicknessMap;
#endif`,OL=`#ifdef OPAQUE
diffuseColor.a = 1.0;
#endif
#ifdef USE_TRANSMISSION
diffuseColor.a *= material.transmissionAlpha;
#endif
gl_FragColor = vec4( outgoingLight, diffuseColor.a );`,NL=`vec3 packNormalToRGB( const in vec3 normal ) {
	return normalize( normal ) * 0.5 + 0.5;
}
vec3 unpackRGBToNormal( const in vec3 rgb ) {
	return 2.0 * rgb.xyz - 1.0;
}
const float PackUpscale = 256. / 255.;const float UnpackDownscale = 255. / 256.;const float ShiftRight8 = 1. / 256.;
const float Inv255 = 1. / 255.;
const vec4 PackFactors = vec4( 1.0, 256.0, 256.0 * 256.0, 256.0 * 256.0 * 256.0 );
const vec2 UnpackFactors2 = vec2( UnpackDownscale, 1.0 / PackFactors.g );
const vec3 UnpackFactors3 = vec3( UnpackDownscale / PackFactors.rg, 1.0 / PackFactors.b );
const vec4 UnpackFactors4 = vec4( UnpackDownscale / PackFactors.rgb, 1.0 / PackFactors.a );
vec4 packDepthToRGBA( const in float v ) {
	if( v <= 0.0 )
		return vec4( 0., 0., 0., 0. );
	if( v >= 1.0 )
		return vec4( 1., 1., 1., 1. );
	float vuf;
	float af = modf( v * PackFactors.a, vuf );
	float bf = modf( vuf * ShiftRight8, vuf );
	float gf = modf( vuf * ShiftRight8, vuf );
	return vec4( vuf * Inv255, gf * PackUpscale, bf * PackUpscale, af );
}
vec3 packDepthToRGB( const in float v ) {
	if( v <= 0.0 )
		return vec3( 0., 0., 0. );
	if( v >= 1.0 )
		return vec3( 1., 1., 1. );
	float vuf;
	float bf = modf( v * PackFactors.b, vuf );
	float gf = modf( vuf * ShiftRight8, vuf );
	return vec3( vuf * Inv255, gf * PackUpscale, bf );
}
vec2 packDepthToRG( const in float v ) {
	if( v <= 0.0 )
		return vec2( 0., 0. );
	if( v >= 1.0 )
		return vec2( 1., 1. );
	float vuf;
	float gf = modf( v * 256., vuf );
	return vec2( vuf * Inv255, gf );
}
float unpackRGBAToDepth( const in vec4 v ) {
	return dot( v, UnpackFactors4 );
}
float unpackRGBToDepth( const in vec3 v ) {
	return dot( v, UnpackFactors3 );
}
float unpackRGToDepth( const in vec2 v ) {
	return v.r * UnpackFactors2.r + v.g * UnpackFactors2.g;
}
vec4 pack2HalfToRGBA( const in vec2 v ) {
	vec4 r = vec4( v.x, fract( v.x * 255.0 ), v.y, fract( v.y * 255.0 ) );
	return vec4( r.x - r.y / 255.0, r.y, r.z - r.w / 255.0, r.w );
}
vec2 unpackRGBATo2Half( const in vec4 v ) {
	return vec2( v.x + ( v.y / 255.0 ), v.z + ( v.w / 255.0 ) );
}
float viewZToOrthographicDepth( const in float viewZ, const in float near, const in float far ) {
	return ( viewZ + near ) / ( near - far );
}
float orthographicDepthToViewZ( const in float depth, const in float near, const in float far ) {
	#ifdef USE_REVERSED_DEPTH_BUFFER
	
		return depth * ( far - near ) - far;
	#else
		return depth * ( near - far ) - near;
	#endif
}
float viewZToPerspectiveDepth( const in float viewZ, const in float near, const in float far ) {
	return ( ( near + viewZ ) * far ) / ( ( far - near ) * viewZ );
}
float perspectiveDepthToViewZ( const in float depth, const in float near, const in float far ) {
	
	#ifdef USE_REVERSED_DEPTH_BUFFER
		return ( near * far ) / ( ( near - far ) * depth - near );
	#else
		return ( near * far ) / ( ( far - near ) * depth - far );
	#endif
}`,FL=`#ifdef PREMULTIPLIED_ALPHA
	gl_FragColor.rgb *= gl_FragColor.a;
#endif`,zL=`vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`,kL=`#ifdef DITHERING
	gl_FragColor.rgb = dithering( gl_FragColor.rgb );
#endif`,HL=`#ifdef DITHERING
	vec3 dithering( vec3 color ) {
		float grid_position = rand( gl_FragCoord.xy );
		vec3 dither_shift_RGB = vec3( 0.25 / 255.0, -0.25 / 255.0, 0.25 / 255.0 );
		dither_shift_RGB = mix( 2.0 * dither_shift_RGB, -2.0 * dither_shift_RGB, grid_position );
		return color + dither_shift_RGB;
	}
#endif`,VL=`float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
	vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
	roughnessFactor *= texelRoughness.g;
#endif`,GL=`#ifdef USE_ROUGHNESSMAP
	uniform sampler2D roughnessMap;
#endif`,qL=`#if NUM_SPOT_LIGHT_COORDS > 0
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#if NUM_SPOT_LIGHT_MAPS > 0
	uniform sampler2D spotLightMap[ NUM_SPOT_LIGHT_MAPS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
		#if defined( SHADOWMAP_TYPE_PCF )
			uniform sampler2DShadow directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
		#else
			uniform sampler2D directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
		#endif
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		#if defined( SHADOWMAP_TYPE_PCF )
			uniform sampler2DShadow spotShadowMap[ NUM_SPOT_LIGHT_SHADOWS ];
		#else
			uniform sampler2D spotShadowMap[ NUM_SPOT_LIGHT_SHADOWS ];
		#endif
		struct SpotLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		#if defined( SHADOWMAP_TYPE_PCF )
			uniform samplerCubeShadow pointShadowMap[ NUM_POINT_LIGHT_SHADOWS ];
		#elif defined( SHADOWMAP_TYPE_BASIC )
			uniform samplerCube pointShadowMap[ NUM_POINT_LIGHT_SHADOWS ];
		#endif
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif
	#if defined( SHADOWMAP_TYPE_PCF )
		float interleavedGradientNoise( vec2 position ) {
			return fract( 52.9829189 * fract( dot( position, vec2( 0.06711056, 0.00583715 ) ) ) );
		}
		vec2 vogelDiskSample( int sampleIndex, int samplesCount, float phi ) {
			const float goldenAngle = 2.399963229728653;
			float r = sqrt( ( float( sampleIndex ) + 0.5 ) / float( samplesCount ) );
			float theta = float( sampleIndex ) * goldenAngle + phi;
			return vec2( cos( theta ), sin( theta ) ) * r;
		}
	#endif
	#if defined( SHADOWMAP_TYPE_PCF )
		float getShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
			float shadow = 1.0;
			shadowCoord.xyz /= shadowCoord.w;
			shadowCoord.z += shadowBias;
			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
			if ( frustumTest ) {
				vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
				float radius = shadowRadius * texelSize.x;
				float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
				shadow = (
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 0, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 1, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 2, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 3, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 4, 5, phi ) * radius, shadowCoord.z ) )
				) * 0.2;
			}
			return mix( 1.0, shadow, shadowIntensity );
		}
	#elif defined( SHADOWMAP_TYPE_VSM )
		float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
			float shadow = 1.0;
			shadowCoord.xyz /= shadowCoord.w;
			#ifdef USE_REVERSED_DEPTH_BUFFER
				shadowCoord.z -= shadowBias;
			#else
				shadowCoord.z += shadowBias;
			#endif
			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
			if ( frustumTest ) {
				vec2 distribution = texture2D( shadowMap, shadowCoord.xy ).rg;
				float mean = distribution.x;
				float variance = distribution.y * distribution.y;
				#ifdef USE_REVERSED_DEPTH_BUFFER
					float hard_shadow = step( mean, shadowCoord.z );
				#else
					float hard_shadow = step( shadowCoord.z, mean );
				#endif
				
				if ( hard_shadow == 1.0 ) {
					shadow = 1.0;
				} else {
					variance = max( variance, 0.0000001 );
					float d = shadowCoord.z - mean;
					float p_max = variance / ( variance + d * d );
					p_max = clamp( ( p_max - 0.3 ) / 0.65, 0.0, 1.0 );
					shadow = max( hard_shadow, p_max );
				}
			}
			return mix( 1.0, shadow, shadowIntensity );
		}
	#else
		float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
			float shadow = 1.0;
			shadowCoord.xyz /= shadowCoord.w;
			#ifdef USE_REVERSED_DEPTH_BUFFER
				shadowCoord.z -= shadowBias;
			#else
				shadowCoord.z += shadowBias;
			#endif
			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
			if ( frustumTest ) {
				float depth = texture2D( shadowMap, shadowCoord.xy ).r;
				#ifdef USE_REVERSED_DEPTH_BUFFER
					shadow = step( depth, shadowCoord.z );
				#else
					shadow = step( shadowCoord.z, depth );
				#endif
			}
			return mix( 1.0, shadow, shadowIntensity );
		}
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
	#if defined( SHADOWMAP_TYPE_PCF )
	float getPointShadow( samplerCubeShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
		float shadow = 1.0;
		vec3 lightToPosition = shadowCoord.xyz;
		vec3 bd3D = normalize( lightToPosition );
		vec3 absVec = abs( lightToPosition );
		float viewSpaceZ = max( max( absVec.x, absVec.y ), absVec.z );
		if ( viewSpaceZ - shadowCameraFar <= 0.0 && viewSpaceZ - shadowCameraNear >= 0.0 ) {
			#ifdef USE_REVERSED_DEPTH_BUFFER
				float dp = ( shadowCameraNear * ( shadowCameraFar - viewSpaceZ ) ) / ( viewSpaceZ * ( shadowCameraFar - shadowCameraNear ) );
				dp -= shadowBias;
			#else
				float dp = ( shadowCameraFar * ( viewSpaceZ - shadowCameraNear ) ) / ( viewSpaceZ * ( shadowCameraFar - shadowCameraNear ) );
				dp += shadowBias;
			#endif
			float texelSize = shadowRadius / shadowMapSize.x;
			vec3 absDir = abs( bd3D );
			vec3 tangent = absDir.x > absDir.z ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
			tangent = normalize( cross( bd3D, tangent ) );
			vec3 bitangent = cross( bd3D, tangent );
			float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
			vec2 sample0 = vogelDiskSample( 0, 5, phi );
			vec2 sample1 = vogelDiskSample( 1, 5, phi );
			vec2 sample2 = vogelDiskSample( 2, 5, phi );
			vec2 sample3 = vogelDiskSample( 3, 5, phi );
			vec2 sample4 = vogelDiskSample( 4, 5, phi );
			shadow = (
				texture( shadowMap, vec4( bd3D + ( tangent * sample0.x + bitangent * sample0.y ) * texelSize, dp ) ) +
				texture( shadowMap, vec4( bd3D + ( tangent * sample1.x + bitangent * sample1.y ) * texelSize, dp ) ) +
				texture( shadowMap, vec4( bd3D + ( tangent * sample2.x + bitangent * sample2.y ) * texelSize, dp ) ) +
				texture( shadowMap, vec4( bd3D + ( tangent * sample3.x + bitangent * sample3.y ) * texelSize, dp ) ) +
				texture( shadowMap, vec4( bd3D + ( tangent * sample4.x + bitangent * sample4.y ) * texelSize, dp ) )
			) * 0.2;
		}
		return mix( 1.0, shadow, shadowIntensity );
	}
	#elif defined( SHADOWMAP_TYPE_BASIC )
	float getPointShadow( samplerCube shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
		float shadow = 1.0;
		vec3 lightToPosition = shadowCoord.xyz;
		vec3 absVec = abs( lightToPosition );
		float viewSpaceZ = max( max( absVec.x, absVec.y ), absVec.z );
		if ( viewSpaceZ - shadowCameraFar <= 0.0 && viewSpaceZ - shadowCameraNear >= 0.0 ) {
			float dp = ( shadowCameraFar * ( viewSpaceZ - shadowCameraNear ) ) / ( viewSpaceZ * ( shadowCameraFar - shadowCameraNear ) );
			dp += shadowBias;
			vec3 bd3D = normalize( lightToPosition );
			float depth = textureCube( shadowMap, bd3D ).r;
			#ifdef USE_REVERSED_DEPTH_BUFFER
				depth = 1.0 - depth;
			#endif
			shadow = step( dp, depth );
		}
		return mix( 1.0, shadow, shadowIntensity );
	}
	#endif
	#endif
#endif`,WL=`#if NUM_SPOT_LIGHT_COORDS > 0
	uniform mat4 spotLightMatrix[ NUM_SPOT_LIGHT_COORDS ];
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
		uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		struct SpotLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		uniform mat4 pointShadowMatrix[ NUM_POINT_LIGHT_SHADOWS ];
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif
#endif`,XL=`#if ( defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 || NUM_POINT_LIGHT_SHADOWS > 0 ) ) || ( NUM_SPOT_LIGHT_COORDS > 0 )
	#ifdef HAS_NORMAL
		vec3 shadowWorldNormal = transformNormalByInverseViewMatrix( transformedNormal, viewMatrix );
	#else
		vec3 shadowWorldNormal = vec3( 0.0 );
	#endif
	vec4 shadowWorldPosition;
#endif
#if defined( USE_SHADOWMAP )
	#if NUM_DIR_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );
			vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * pointLightShadows[ i ].shadowNormalBias, 0 );
			vPointShadowCoord[ i ] = pointShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
#endif
#if NUM_SPOT_LIGHT_COORDS > 0
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
		shadowWorldPosition = worldPosition;
		#if ( defined( USE_SHADOWMAP ) && UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
			shadowWorldPosition.xyz += shadowWorldNormal * spotLightShadows[ i ].shadowNormalBias;
		#endif
		vSpotLightCoord[ i ] = spotLightMatrix[ i ] * shadowWorldPosition;
	}
	#pragma unroll_loop_end
#endif`,YL=`float getShadowMask() {
	float shadow = 1.0;
	#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
		directionalLight = directionalLightShadows[ i ];
		shadow *= receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLight.shadowMapSize, directionalLight.shadowIntensity, directionalLight.shadowBias, directionalLight.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_SHADOWS; i ++ ) {
		spotLight = spotLightShadows[ i ];
		shadow *= receiveShadow ? getShadow( spotShadowMap[ i ], spotLight.shadowMapSize, spotLight.shadowIntensity, spotLight.shadowBias, spotLight.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0 && ( defined( SHADOWMAP_TYPE_PCF ) || defined( SHADOWMAP_TYPE_BASIC ) )
	PointLightShadow pointLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
		pointLight = pointLightShadows[ i ];
		shadow *= receiveShadow ? getPointShadow( pointShadowMap[ i ], pointLight.shadowMapSize, pointLight.shadowIntensity, pointLight.shadowBias, pointLight.shadowRadius, vPointShadowCoord[ i ], pointLight.shadowCameraNear, pointLight.shadowCameraFar ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#endif
	return shadow;
}`,ZL=`#ifdef USE_SKINNING
	mat4 boneMatX = getBoneMatrix( skinIndex.x );
	mat4 boneMatY = getBoneMatrix( skinIndex.y );
	mat4 boneMatZ = getBoneMatrix( skinIndex.z );
	mat4 boneMatW = getBoneMatrix( skinIndex.w );
#endif`,KL=`#ifdef USE_SKINNING
	uniform mat4 bindMatrix;
	uniform mat4 bindMatrixInverse;
	uniform highp sampler2D boneTexture;
	mat4 getBoneMatrix( const in float i ) {
		int size = textureSize( boneTexture, 0 ).x;
		int j = int( i ) * 4;
		int x = j % size;
		int y = j / size;
		vec4 v1 = texelFetch( boneTexture, ivec2( x, y ), 0 );
		vec4 v2 = texelFetch( boneTexture, ivec2( x + 1, y ), 0 );
		vec4 v3 = texelFetch( boneTexture, ivec2( x + 2, y ), 0 );
		vec4 v4 = texelFetch( boneTexture, ivec2( x + 3, y ), 0 );
		return mat4( v1, v2, v3, v4 );
	}
#endif`,JL=`#ifdef USE_SKINNING
	vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );
	vec4 skinned = vec4( 0.0 );
	skinned += boneMatX * skinVertex * skinWeight.x;
	skinned += boneMatY * skinVertex * skinWeight.y;
	skinned += boneMatZ * skinVertex * skinWeight.z;
	skinned += boneMatW * skinVertex * skinWeight.w;
	transformed = ( bindMatrixInverse * skinned ).xyz;
#endif`,QL=`#ifdef USE_SKINNING
	mat4 skinMatrix = mat4( 0.0 );
	skinMatrix += skinWeight.x * boneMatX;
	skinMatrix += skinWeight.y * boneMatY;
	skinMatrix += skinWeight.z * boneMatZ;
	skinMatrix += skinWeight.w * boneMatW;
	skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
	objectNormal = vec4( skinMatrix * vec4( objectNormal, 0.0 ) ).xyz;
	#ifdef USE_TANGENT
		objectTangent = vec4( skinMatrix * vec4( objectTangent, 0.0 ) ).xyz;
	#endif
#endif`,jL=`float specularStrength;
#ifdef USE_SPECULARMAP
	vec4 texelSpecular = texture2D( specularMap, vSpecularMapUv );
	specularStrength = texelSpecular.r;
#else
	specularStrength = 1.0;
#endif`,$L=`#ifdef USE_SPECULARMAP
	uniform sampler2D specularMap;
#endif`,eA=`#if defined( TONE_MAPPING )
	gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );
#endif`,tA=`#ifndef saturate
#define saturate( a ) clamp( a, 0.0, 1.0 )
#endif
uniform float toneMappingExposure;
vec3 LinearToneMapping( vec3 color ) {
	return saturate( toneMappingExposure * color );
}
vec3 ReinhardToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	return saturate( color / ( vec3( 1.0 ) + color ) );
}
vec3 CineonToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	color = max( vec3( 0.0 ), color - 0.004 );
	return pow( ( color * ( 6.2 * color + 0.5 ) ) / ( color * ( 6.2 * color + 1.7 ) + 0.06 ), vec3( 2.2 ) );
}
vec3 RRTAndODTFit( vec3 v ) {
	vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
	vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
	return a / b;
}
vec3 ACESFilmicToneMapping( vec3 color ) {
	const mat3 ACESInputMat = mat3(
		vec3( 0.59719, 0.07600, 0.02840 ),		vec3( 0.35458, 0.90834, 0.13383 ),
		vec3( 0.04823, 0.01566, 0.83777 )
	);
	const mat3 ACESOutputMat = mat3(
		vec3(  1.60475, -0.10208, -0.00327 ),		vec3( -0.53108,  1.10813, -0.07276 ),
		vec3( -0.07367, -0.00605,  1.07602 )
	);
	color *= toneMappingExposure / 0.6;
	color = ACESInputMat * color;
	color = RRTAndODTFit( color );
	color = ACESOutputMat * color;
	return saturate( color );
}
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
	vec3( 1.6605, - 0.1246, - 0.0182 ),
	vec3( - 0.5876, 1.1329, - 0.1006 ),
	vec3( - 0.0728, - 0.0083, 1.1187 )
);
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
	vec3( 0.6274, 0.0691, 0.0164 ),
	vec3( 0.3293, 0.9195, 0.0880 ),
	vec3( 0.0433, 0.0113, 0.8956 )
);
vec3 agxDefaultContrastApprox( vec3 x ) {
	vec3 x2 = x * x;
	vec3 x4 = x2 * x2;
	return + 15.5 * x4 * x2
		- 40.14 * x4 * x
		+ 31.96 * x4
		- 6.868 * x2 * x
		+ 0.4298 * x2
		+ 0.1191 * x
		- 0.00232;
}
vec3 AgXToneMapping( vec3 color ) {
	const mat3 AgXInsetMatrix = mat3(
		vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
		vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
		vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 )
	);
	const mat3 AgXOutsetMatrix = mat3(
		vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
		vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
		vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 )
	);
	const float AgxMinEv = - 12.47393;	const float AgxMaxEv = 4.026069;
	color *= toneMappingExposure;
	color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
	color = AgXInsetMatrix * color;
	color = max( color, 1e-10 );	color = log2( color );
	color = ( color - AgxMinEv ) / ( AgxMaxEv - AgxMinEv );
	color = clamp( color, 0.0, 1.0 );
	color = agxDefaultContrastApprox( color );
	color = AgXOutsetMatrix * color;
	color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
	color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
	color = clamp( color, 0.0, 1.0 );
	return color;
}
vec3 NeutralToneMapping( vec3 color ) {
	const float StartCompression = 0.8 - 0.04;
	const float Desaturation = 0.15;
	color *= toneMappingExposure;
	float x = min( color.r, min( color.g, color.b ) );
	float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
	color -= offset;
	float peak = max( color.r, max( color.g, color.b ) );
	if ( peak < StartCompression ) return color;
	float d = 1. - StartCompression;
	float newPeak = 1. - d * d / ( peak + d - StartCompression );
	color *= newPeak / peak;
	float g = 1. - 1. / ( Desaturation * ( peak - newPeak ) + 1. );
	return mix( color, vec3( newPeak ), g );
}
vec3 CustomToneMapping( vec3 color ) { return color; }`,aA=`#ifdef USE_TRANSMISSION
	material.transmission = transmission;
	material.transmissionAlpha = 1.0;
	material.thickness = thickness;
	material.attenuationDistance = attenuationDistance;
	material.attenuationColor = attenuationColor;
	#ifdef USE_TRANSMISSIONMAP
		material.transmission *= texture2D( transmissionMap, vTransmissionMapUv ).r;
	#endif
	#ifdef USE_THICKNESSMAP
		material.thickness *= texture2D( thicknessMap, vThicknessMapUv ).g;
	#endif
	vec3 pos = vWorldPosition;
	vec3 v = normalize( cameraPosition - pos );
	vec3 n = transformNormalByInverseViewMatrix( normal, viewMatrix );
	vec4 transmitted = getIBLVolumeRefraction(
		n, v, material.roughness, material.diffuseContribution, material.specularColorBlended, material.specularF90,
		pos, modelMatrix, viewMatrix, projectionMatrix, material.dispersion, material.ior, material.thickness,
		material.attenuationColor, material.attenuationDistance );
	material.transmissionAlpha = mix( material.transmissionAlpha, transmitted.a, material.transmission );
	totalDiffuse = mix( totalDiffuse, transmitted.rgb, material.transmission );
#endif`,nA=`#ifdef USE_TRANSMISSION
	uniform float transmission;
	uniform float thickness;
	uniform float attenuationDistance;
	uniform vec3 attenuationColor;
	#ifdef USE_TRANSMISSIONMAP
		uniform sampler2D transmissionMap;
	#endif
	#ifdef USE_THICKNESSMAP
		uniform sampler2D thicknessMap;
	#endif
	uniform vec2 transmissionSamplerSize;
	uniform sampler2D transmissionSamplerMap;
	uniform mat4 modelMatrix;
	uniform mat4 projectionMatrix;
	varying vec3 vWorldPosition;
	float w0( float a ) {
		return ( 1.0 / 6.0 ) * ( a * ( a * ( - a + 3.0 ) - 3.0 ) + 1.0 );
	}
	float w1( float a ) {
		return ( 1.0 / 6.0 ) * ( a *  a * ( 3.0 * a - 6.0 ) + 4.0 );
	}
	float w2( float a ){
		return ( 1.0 / 6.0 ) * ( a * ( a * ( - 3.0 * a + 3.0 ) + 3.0 ) + 1.0 );
	}
	float w3( float a ) {
		return ( 1.0 / 6.0 ) * ( a * a * a );
	}
	float g0( float a ) {
		return w0( a ) + w1( a );
	}
	float g1( float a ) {
		return w2( a ) + w3( a );
	}
	float h0( float a ) {
		return - 1.0 + w1( a ) / ( w0( a ) + w1( a ) );
	}
	float h1( float a ) {
		return 1.0 + w3( a ) / ( w2( a ) + w3( a ) );
	}
	vec4 bicubic( sampler2D tex, vec2 uv, vec4 texelSize, float lod ) {
		uv = uv * texelSize.zw + 0.5;
		vec2 iuv = floor( uv );
		vec2 fuv = fract( uv );
		float g0x = g0( fuv.x );
		float g1x = g1( fuv.x );
		float h0x = h0( fuv.x );
		float h1x = h1( fuv.x );
		float h0y = h0( fuv.y );
		float h1y = h1( fuv.y );
		vec2 p0 = ( vec2( iuv.x + h0x, iuv.y + h0y ) - 0.5 ) * texelSize.xy;
		vec2 p1 = ( vec2( iuv.x + h1x, iuv.y + h0y ) - 0.5 ) * texelSize.xy;
		vec2 p2 = ( vec2( iuv.x + h0x, iuv.y + h1y ) - 0.5 ) * texelSize.xy;
		vec2 p3 = ( vec2( iuv.x + h1x, iuv.y + h1y ) - 0.5 ) * texelSize.xy;
		return g0( fuv.y ) * ( g0x * textureLod( tex, p0, lod ) + g1x * textureLod( tex, p1, lod ) ) +
			g1( fuv.y ) * ( g0x * textureLod( tex, p2, lod ) + g1x * textureLod( tex, p3, lod ) );
	}
	vec4 textureBicubic( sampler2D sampler, vec2 uv, float lod ) {
		vec2 fLodSize = vec2( textureSize( sampler, int( lod ) ) );
		vec2 cLodSize = vec2( textureSize( sampler, int( lod + 1.0 ) ) );
		vec2 fLodSizeInv = 1.0 / fLodSize;
		vec2 cLodSizeInv = 1.0 / cLodSize;
		vec4 fSample = bicubic( sampler, uv, vec4( fLodSizeInv, fLodSize ), floor( lod ) );
		vec4 cSample = bicubic( sampler, uv, vec4( cLodSizeInv, cLodSize ), ceil( lod ) );
		return mix( fSample, cSample, fract( lod ) );
	}
	vec3 getVolumeTransmissionRay( const in vec3 n, const in vec3 v, const in float thickness, const in float ior, const in mat4 modelMatrix ) {
		vec3 refractionVector = refract( - v, normalize( n ), 1.0 / ior );
		vec3 modelScale;
		modelScale.x = length( vec3( modelMatrix[ 0 ].xyz ) );
		modelScale.y = length( vec3( modelMatrix[ 1 ].xyz ) );
		modelScale.z = length( vec3( modelMatrix[ 2 ].xyz ) );
		return normalize( refractionVector ) * thickness * modelScale;
	}
	float applyIorToRoughness( const in float roughness, const in float ior ) {
		return roughness * clamp( ior * 2.0 - 2.0, 0.0, 1.0 );
	}
	vec4 getTransmissionSample( const in vec2 fragCoord, const in float roughness, const in float ior ) {
		float lod = log2( transmissionSamplerSize.x ) * applyIorToRoughness( roughness, ior );
		return textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );
	}
	vec3 volumeAttenuation( const in float transmissionDistance, const in vec3 attenuationColor, const in float attenuationDistance ) {
		if ( isinf( attenuationDistance ) ) {
			return vec3( 1.0 );
		} else {
			vec3 attenuationCoefficient = -log( attenuationColor ) / attenuationDistance;
			vec3 transmittance = exp( - attenuationCoefficient * transmissionDistance );			return transmittance;
		}
	}
	vec4 getIBLVolumeRefraction( const in vec3 n, const in vec3 v, const in float roughness, const in vec3 diffuseColor,
		const in vec3 specularColor, const in float specularF90, const in vec3 position, const in mat4 modelMatrix,
		const in mat4 viewMatrix, const in mat4 projMatrix, const in float dispersion, const in float ior, const in float thickness,
		const in vec3 attenuationColor, const in float attenuationDistance ) {
		vec4 transmittedLight;
		vec3 transmittance;
		#ifdef USE_DISPERSION
			float halfSpread = ( ior - 1.0 ) * 0.025 * dispersion;
			vec3 iors = vec3( ior - halfSpread, ior, ior + halfSpread );
			for ( int i = 0; i < 3; i ++ ) {
				vec3 transmissionRay = getVolumeTransmissionRay( n, v, thickness, iors[ i ], modelMatrix );
				vec3 refractedRayExit = position + transmissionRay;
				vec4 ndcPos = projMatrix * viewMatrix * vec4( refractedRayExit, 1.0 );
				vec2 refractionCoords = ndcPos.xy / ndcPos.w;
				refractionCoords += 1.0;
				refractionCoords /= 2.0;
				vec4 transmissionSample = getTransmissionSample( refractionCoords, roughness, iors[ i ] );
				transmittedLight[ i ] = transmissionSample[ i ];
				transmittedLight.a += transmissionSample.a;
				transmittance[ i ] = diffuseColor[ i ] * volumeAttenuation( length( transmissionRay ), attenuationColor, attenuationDistance )[ i ];
			}
			transmittedLight.a /= 3.0;
		#else
			vec3 transmissionRay = getVolumeTransmissionRay( n, v, thickness, ior, modelMatrix );
			vec3 refractedRayExit = position + transmissionRay;
			vec4 ndcPos = projMatrix * viewMatrix * vec4( refractedRayExit, 1.0 );
			vec2 refractionCoords = ndcPos.xy / ndcPos.w;
			refractionCoords += 1.0;
			refractionCoords /= 2.0;
			transmittedLight = getTransmissionSample( refractionCoords, roughness, ior );
			transmittance = diffuseColor * volumeAttenuation( length( transmissionRay ), attenuationColor, attenuationDistance );
		#endif
		vec3 attenuatedColor = transmittance * transmittedLight.rgb;
		vec3 F = EnvironmentBRDF( n, v, specularColor, specularF90, roughness );
		float transmittanceFactor = ( transmittance.r + transmittance.g + transmittance.b ) / 3.0;
		return vec4( ( 1.0 - F ) * attenuatedColor, 1.0 - ( 1.0 - transmittedLight.a ) * transmittanceFactor );
	}
#endif`,iA=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	varying vec2 vUv;
#endif
#ifdef USE_MAP
	varying vec2 vMapUv;
#endif
#ifdef USE_ALPHAMAP
	varying vec2 vAlphaMapUv;
#endif
#ifdef USE_LIGHTMAP
	varying vec2 vLightMapUv;
#endif
#ifdef USE_AOMAP
	varying vec2 vAoMapUv;
#endif
#ifdef USE_BUMPMAP
	varying vec2 vBumpMapUv;
#endif
#ifdef USE_NORMALMAP
	varying vec2 vNormalMapUv;
#endif
#ifdef USE_EMISSIVEMAP
	varying vec2 vEmissiveMapUv;
#endif
#ifdef USE_METALNESSMAP
	varying vec2 vMetalnessMapUv;
#endif
#ifdef USE_ROUGHNESSMAP
	varying vec2 vRoughnessMapUv;
#endif
#ifdef USE_ANISOTROPYMAP
	varying vec2 vAnisotropyMapUv;
#endif
#ifdef USE_CLEARCOATMAP
	varying vec2 vClearcoatMapUv;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	varying vec2 vClearcoatNormalMapUv;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	varying vec2 vClearcoatRoughnessMapUv;
#endif
#ifdef USE_IRIDESCENCEMAP
	varying vec2 vIridescenceMapUv;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	varying vec2 vIridescenceThicknessMapUv;
#endif
#ifdef USE_SHEEN_COLORMAP
	varying vec2 vSheenColorMapUv;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	varying vec2 vSheenRoughnessMapUv;
#endif
#ifdef USE_SPECULARMAP
	varying vec2 vSpecularMapUv;
#endif
#ifdef USE_SPECULAR_COLORMAP
	varying vec2 vSpecularColorMapUv;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	varying vec2 vSpecularIntensityMapUv;
#endif
#ifdef USE_TRANSMISSIONMAP
	uniform mat3 transmissionMapTransform;
	varying vec2 vTransmissionMapUv;
#endif
#ifdef USE_THICKNESSMAP
	uniform mat3 thicknessMapTransform;
	varying vec2 vThicknessMapUv;
#endif`,sA=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	varying vec2 vUv;
#endif
#ifdef USE_MAP
	uniform mat3 mapTransform;
	varying vec2 vMapUv;
#endif
#ifdef USE_ALPHAMAP
	uniform mat3 alphaMapTransform;
	varying vec2 vAlphaMapUv;
#endif
#ifdef USE_LIGHTMAP
	uniform mat3 lightMapTransform;
	varying vec2 vLightMapUv;
#endif
#ifdef USE_AOMAP
	uniform mat3 aoMapTransform;
	varying vec2 vAoMapUv;
#endif
#ifdef USE_BUMPMAP
	uniform mat3 bumpMapTransform;
	varying vec2 vBumpMapUv;
#endif
#ifdef USE_NORMALMAP
	uniform mat3 normalMapTransform;
	varying vec2 vNormalMapUv;
#endif
#ifdef USE_DISPLACEMENTMAP
	uniform mat3 displacementMapTransform;
	varying vec2 vDisplacementMapUv;
#endif
#ifdef USE_EMISSIVEMAP
	uniform mat3 emissiveMapTransform;
	varying vec2 vEmissiveMapUv;
#endif
#ifdef USE_METALNESSMAP
	uniform mat3 metalnessMapTransform;
	varying vec2 vMetalnessMapUv;
#endif
#ifdef USE_ROUGHNESSMAP
	uniform mat3 roughnessMapTransform;
	varying vec2 vRoughnessMapUv;
#endif
#ifdef USE_ANISOTROPYMAP
	uniform mat3 anisotropyMapTransform;
	varying vec2 vAnisotropyMapUv;
#endif
#ifdef USE_CLEARCOATMAP
	uniform mat3 clearcoatMapTransform;
	varying vec2 vClearcoatMapUv;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	uniform mat3 clearcoatNormalMapTransform;
	varying vec2 vClearcoatNormalMapUv;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	uniform mat3 clearcoatRoughnessMapTransform;
	varying vec2 vClearcoatRoughnessMapUv;
#endif
#ifdef USE_SHEEN_COLORMAP
	uniform mat3 sheenColorMapTransform;
	varying vec2 vSheenColorMapUv;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	uniform mat3 sheenRoughnessMapTransform;
	varying vec2 vSheenRoughnessMapUv;
#endif
#ifdef USE_IRIDESCENCEMAP
	uniform mat3 iridescenceMapTransform;
	varying vec2 vIridescenceMapUv;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	uniform mat3 iridescenceThicknessMapTransform;
	varying vec2 vIridescenceThicknessMapUv;
#endif
#ifdef USE_SPECULARMAP
	uniform mat3 specularMapTransform;
	varying vec2 vSpecularMapUv;
#endif
#ifdef USE_SPECULAR_COLORMAP
	uniform mat3 specularColorMapTransform;
	varying vec2 vSpecularColorMapUv;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	uniform mat3 specularIntensityMapTransform;
	varying vec2 vSpecularIntensityMapUv;
#endif
#ifdef USE_TRANSMISSIONMAP
	uniform mat3 transmissionMapTransform;
	varying vec2 vTransmissionMapUv;
#endif
#ifdef USE_THICKNESSMAP
	uniform mat3 thicknessMapTransform;
	varying vec2 vThicknessMapUv;
#endif`,rA=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	vUv = vec3( uv, 1 ).xy;
#endif
#ifdef USE_MAP
	vMapUv = ( mapTransform * vec3( MAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ALPHAMAP
	vAlphaMapUv = ( alphaMapTransform * vec3( ALPHAMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_LIGHTMAP
	vLightMapUv = ( lightMapTransform * vec3( LIGHTMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_AOMAP
	vAoMapUv = ( aoMapTransform * vec3( AOMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_BUMPMAP
	vBumpMapUv = ( bumpMapTransform * vec3( BUMPMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_NORMALMAP
	vNormalMapUv = ( normalMapTransform * vec3( NORMALMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_DISPLACEMENTMAP
	vDisplacementMapUv = ( displacementMapTransform * vec3( DISPLACEMENTMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_EMISSIVEMAP
	vEmissiveMapUv = ( emissiveMapTransform * vec3( EMISSIVEMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_METALNESSMAP
	vMetalnessMapUv = ( metalnessMapTransform * vec3( METALNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ROUGHNESSMAP
	vRoughnessMapUv = ( roughnessMapTransform * vec3( ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ANISOTROPYMAP
	vAnisotropyMapUv = ( anisotropyMapTransform * vec3( ANISOTROPYMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOATMAP
	vClearcoatMapUv = ( clearcoatMapTransform * vec3( CLEARCOATMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	vClearcoatNormalMapUv = ( clearcoatNormalMapTransform * vec3( CLEARCOAT_NORMALMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	vClearcoatRoughnessMapUv = ( clearcoatRoughnessMapTransform * vec3( CLEARCOAT_ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_IRIDESCENCEMAP
	vIridescenceMapUv = ( iridescenceMapTransform * vec3( IRIDESCENCEMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	vIridescenceThicknessMapUv = ( iridescenceThicknessMapTransform * vec3( IRIDESCENCE_THICKNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SHEEN_COLORMAP
	vSheenColorMapUv = ( sheenColorMapTransform * vec3( SHEEN_COLORMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	vSheenRoughnessMapUv = ( sheenRoughnessMapTransform * vec3( SHEEN_ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULARMAP
	vSpecularMapUv = ( specularMapTransform * vec3( SPECULARMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULAR_COLORMAP
	vSpecularColorMapUv = ( specularColorMapTransform * vec3( SPECULAR_COLORMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	vSpecularIntensityMapUv = ( specularIntensityMapTransform * vec3( SPECULAR_INTENSITYMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_TRANSMISSIONMAP
	vTransmissionMapUv = ( transmissionMapTransform * vec3( TRANSMISSIONMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_THICKNESSMAP
	vThicknessMapUv = ( thicknessMapTransform * vec3( THICKNESSMAP_UV, 1 ) ).xy;
#endif`,oA=`#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
	vec4 worldPosition = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		worldPosition = batchingMatrix * worldPosition;
	#endif
	#ifdef USE_INSTANCING
		worldPosition = instanceMatrix * worldPosition;
	#endif
	worldPosition = modelMatrix * worldPosition;
#endif`,lA=`varying vec2 vUv;
uniform mat3 uvTransform;
void main() {
	vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
	gl_Position = vec4( position.xy, 1.0, 1.0 );
}`,uA=`uniform sampler2D t2D;
uniform float backgroundIntensity;
varying vec2 vUv;
void main() {
	vec4 texColor = texture2D( t2D, vUv );
	#ifdef DECODE_VIDEO_TEXTURE
		texColor = vec4( mix( pow( texColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), texColor.rgb * 0.0773993808, vec3( lessThanEqual( texColor.rgb, vec3( 0.04045 ) ) ) ), texColor.w );
	#endif
	texColor.rgb *= backgroundIntensity;
	gl_FragColor = texColor;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,cA=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
	gl_Position.z = gl_Position.w;
}`,fA=`#ifdef ENVMAP_TYPE_CUBE
	uniform samplerCube envMap;
#elif defined( ENVMAP_TYPE_CUBE_UV )
	uniform sampler2D envMap;
#endif
uniform float backgroundBlurriness;
uniform float backgroundIntensity;
uniform mat3 backgroundRotation;
varying vec3 vWorldDirection;
#include <cube_uv_reflection_fragment>
void main() {
	#ifdef ENVMAP_TYPE_CUBE
		vec4 texColor = textureCube( envMap, backgroundRotation * vWorldDirection );
	#elif defined( ENVMAP_TYPE_CUBE_UV )
		vec4 texColor = textureCubeUV( envMap, backgroundRotation * vWorldDirection, backgroundBlurriness );
	#else
		vec4 texColor = vec4( 0.0, 0.0, 0.0, 1.0 );
	#endif
	texColor.rgb *= backgroundIntensity;
	gl_FragColor = texColor;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,dA=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
	gl_Position.z = gl_Position.w;
}`,hA=`uniform samplerCube tCube;
uniform float tFlip;
uniform float opacity;
varying vec3 vWorldDirection;
void main() {
	vec4 texColor = textureCube( tCube, vec3( tFlip * vWorldDirection.x, vWorldDirection.yz ) );
	gl_FragColor = texColor;
	gl_FragColor.a *= opacity;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,pA=`#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
varying vec2 vHighPrecisionZW;
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <skinbase_vertex>
	#include <morphinstance_vertex>
	#ifdef USE_DISPLACEMENTMAP
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vHighPrecisionZW = gl_Position.zw;
}`,mA=`#if DEPTH_PACKING == 3200
	uniform float opacity;
#endif
#include <common>
#include <packing>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
varying vec2 vHighPrecisionZW;
void main() {
	vec4 diffuseColor = vec4( 1.0 );
	#include <clipping_planes_fragment>
	#if DEPTH_PACKING == 3200
		diffuseColor.a = opacity;
	#endif
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <logdepthbuf_fragment>
	#ifdef USE_REVERSED_DEPTH_BUFFER
		float fragCoordZ = vHighPrecisionZW[ 0 ] / vHighPrecisionZW[ 1 ];
	#else
		float fragCoordZ = 0.5 * vHighPrecisionZW[ 0 ] / vHighPrecisionZW[ 1 ] + 0.5;
	#endif
	#if DEPTH_PACKING == 3200
		gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );
	#elif DEPTH_PACKING == 3201
		gl_FragColor = packDepthToRGBA( fragCoordZ );
	#elif DEPTH_PACKING == 3202
		gl_FragColor = vec4( packDepthToRGB( fragCoordZ ), 1.0 );
	#elif DEPTH_PACKING == 3203
		gl_FragColor = vec4( packDepthToRG( fragCoordZ ), 0.0, 1.0 );
	#endif
}`,gA=`#define DISTANCE
varying vec3 vWorldPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <skinbase_vertex>
	#include <morphinstance_vertex>
	#ifdef USE_DISPLACEMENTMAP
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <worldpos_vertex>
	#include <clipping_planes_vertex>
	vWorldPosition = worldPosition.xyz;
}`,xA=`#define DISTANCE
uniform vec3 referencePosition;
uniform float nearDistance;
uniform float farDistance;
varying vec3 vWorldPosition;
#include <common>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( 1.0 );
	#include <clipping_planes_fragment>
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	float dist = length( vWorldPosition - referencePosition );
	dist = ( dist - nearDistance ) / ( farDistance - nearDistance );
	dist = saturate( dist );
	gl_FragColor = vec4( dist, 0.0, 0.0, 1.0 );
}`,vA=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
}`,yA=`uniform sampler2D tEquirect;
varying vec3 vWorldDirection;
#include <common>
void main() {
	vec3 direction = normalize( vWorldDirection );
	vec2 sampleUV = equirectUv( direction );
	gl_FragColor = texture2D( tEquirect, sampleUV );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,_A=`uniform float scale;
attribute float lineDistance;
varying float vLineDistance;
#include <common>
#include <uv_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	vLineDistance = scale * lineDistance;
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
}`,SA=`uniform vec3 diffuse;
uniform float opacity;
uniform float dashSize;
uniform float totalSize;
varying float vLineDistance;
#include <common>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	if ( mod( vLineDistance, totalSize ) > dashSize ) {
		discard;
	}
	vec3 outgoingLight = vec3( 0.0 );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,MA=`#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinbase_vertex>
		#include <skinnormal_vertex>
		#include <defaultnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <fog_vertex>
}`,bA=`uniform vec3 diffuse;
uniform float opacity;
#ifndef FLAT_SHADED
	varying vec3 vNormal;
#endif
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		reflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;
	#else
		reflectedLight.indirectDiffuse += vec3( 1.0 );
	#endif
	#include <aomap_fragment>
	reflectedLight.indirectDiffuse *= diffuseColor.rgb;
	vec3 outgoingLight = reflectedLight.indirectDiffuse;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,CA=`#define LAMBERT
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,LA=`#define LAMBERT
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float opacity;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <cube_uv_reflection_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <envmap_physical_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_lambert_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_lambert_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,AA=`#define MATCAP
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <color_pars_vertex>
#include <displacementmap_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
	vViewPosition = - mvPosition.xyz;
}`,TA=`#define MATCAP
uniform vec3 diffuse;
uniform float opacity;
uniform sampler2D matcap;
varying vec3 vViewPosition;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	vec3 viewDir = normalize( vViewPosition );
	vec3 x = normalize( vec3( viewDir.z, 0.0, - viewDir.x ) );
	vec3 y = cross( viewDir, x );
	vec2 uv = vec2( dot( x, normal ), dot( y, normal ) ) * 0.495 + 0.5;
	#ifdef USE_MATCAP
		vec4 matcapColor = texture2D( matcap, uv );
	#else
		vec4 matcapColor = vec4( vec3( mix( 0.2, 0.8, uv.y ) ), 1.0 );
	#endif
	vec3 outgoingLight = diffuseColor.rgb * matcapColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,IA=`#define NORMAL
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	varying vec3 vViewPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphinstance_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	vViewPosition = - mvPosition.xyz;
#endif
}`,EA=`#define NORMAL
uniform float opacity;
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	varying vec3 vViewPosition;
#endif
#include <uv_pars_fragment>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( 0.0, 0.0, 0.0, opacity );
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	gl_FragColor = vec4( normalize( normal ) * 0.5 + 0.5, diffuseColor.a );
	#ifdef OPAQUE
		gl_FragColor.a = 1.0;
	#endif
}`,wA=`#define PHONG
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphinstance_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,RA=`#define PHONG
uniform vec3 diffuse;
uniform vec3 emissive;
uniform vec3 specular;
uniform float shininess;
uniform float opacity;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <cube_uv_reflection_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <envmap_physical_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_phong_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_phong_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular + totalEmissiveRadiance;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,DA=`#define STANDARD
varying vec3 vViewPosition;
#ifdef USE_TRANSMISSION
	varying vec3 vWorldPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
#ifdef USE_TRANSMISSION
	vWorldPosition = worldPosition.xyz;
#endif
}`,PA=`#define STANDARD
#ifdef PHYSICAL
	#define IOR
	#define USE_SPECULAR
#endif
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float roughness;
uniform float metalness;
uniform float opacity;
#ifdef IOR
	uniform float ior;
#endif
#ifdef USE_SPECULAR
	uniform float specularIntensity;
	uniform vec3 specularColor;
	#ifdef USE_SPECULAR_COLORMAP
		uniform sampler2D specularColorMap;
	#endif
	#ifdef USE_SPECULAR_INTENSITYMAP
		uniform sampler2D specularIntensityMap;
	#endif
#endif
#ifdef USE_CLEARCOAT
	uniform float clearcoat;
	uniform float clearcoatRoughness;
#endif
#ifdef USE_DISPERSION
	uniform float dispersion;
#endif
#ifdef USE_IRIDESCENCE
	uniform float iridescence;
	uniform float iridescenceIOR;
	uniform float iridescenceThicknessMinimum;
	uniform float iridescenceThicknessMaximum;
#endif
#ifdef USE_SHEEN
	uniform vec3 sheenColor;
	uniform float sheenRoughness;
	#ifdef USE_SHEEN_COLORMAP
		uniform sampler2D sheenColorMap;
	#endif
	#ifdef USE_SHEEN_ROUGHNESSMAP
		uniform sampler2D sheenRoughnessMap;
	#endif
#endif
#ifdef USE_ANISOTROPY
	uniform vec2 anisotropyVector;
	#ifdef USE_ANISOTROPYMAP
		uniform sampler2D anisotropyMap;
	#endif
#endif
varying vec3 vViewPosition;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <iridescence_fragment>
#include <cube_uv_reflection_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_physical_pars_fragment>
#include <fog_pars_fragment>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_physical_pars_fragment>
#include <transmission_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <clearcoat_pars_fragment>
#include <iridescence_pars_fragment>
#include <roughnessmap_pars_fragment>
#include <metalnessmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <roughnessmap_fragment>
	#include <metalnessmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <clearcoat_normal_fragment_begin>
	#include <clearcoat_normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_physical_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
	vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
	#include <transmission_fragment>
	vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
	#ifdef USE_SHEEN
 
		outgoingLight = outgoingLight + sheenSpecularDirect + sheenSpecularIndirect;
 
 	#endif
	#ifdef USE_CLEARCOAT
		float dotNVcc = saturate( dot( geometryClearcoatNormal, geometryViewDir ) );
		vec3 Fcc = F_Schlick( material.clearcoatF0, material.clearcoatF90, dotNVcc );
		outgoingLight = outgoingLight * ( 1.0 - material.clearcoat * Fcc ) + ( clearcoatSpecularDirect + clearcoatSpecularIndirect ) * material.clearcoat;
	#endif
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,UA=`#define TOON
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,BA=`#define TOON
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float opacity;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <gradientmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_toon_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_toon_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,OA=`uniform float size;
uniform float scale;
#include <common>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
#ifdef USE_POINTS_UV
	varying vec2 vUv;
	uniform mat3 uvTransform;
#endif
void main() {
	#ifdef USE_POINTS_UV
		vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
	#endif
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <project_vertex>
	gl_PointSize = size;
	#ifdef USE_SIZEATTENUATION
		bool isPerspective = isPerspectiveMatrix( projectionMatrix );
		if ( isPerspective ) gl_PointSize *= ( scale / - mvPosition.z );
	#endif
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <worldpos_vertex>
	#include <fog_vertex>
}`,NA=`uniform vec3 diffuse;
uniform float opacity;
#include <common>
#include <color_pars_fragment>
#include <map_particle_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	vec3 outgoingLight = vec3( 0.0 );
	#include <logdepthbuf_fragment>
	#include <map_particle_fragment>
	#include <color_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,FA=`#include <common>
#include <batching_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <shadowmap_pars_vertex>
void main() {
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphinstance_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,zA=`uniform vec3 color;
uniform float opacity;
#include <common>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <logdepthbuf_pars_fragment>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
void main() {
	#include <logdepthbuf_fragment>
	gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,kA=`uniform float rotation;
uniform vec2 center;
#include <common>
#include <uv_pars_vertex>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	vec4 mvPosition = modelViewMatrix[ 3 ];
	vec2 scale = vec2( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ) );
	#ifndef USE_SIZEATTENUATION
		bool isPerspective = isPerspectiveMatrix( projectionMatrix );
		if ( isPerspective ) scale *= - mvPosition.z;
	#endif
	vec2 alignedPosition = ( position.xy - ( center - vec2( 0.5 ) ) ) * scale;
	vec2 rotatedPosition;
	rotatedPosition.x = cos( rotation ) * alignedPosition.x - sin( rotation ) * alignedPosition.y;
	rotatedPosition.y = sin( rotation ) * alignedPosition.x + cos( rotation ) * alignedPosition.y;
	mvPosition.xy += rotatedPosition;
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
}`,HA=`uniform vec3 diffuse;
uniform float opacity;
#include <common>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	vec3 outgoingLight = vec3( 0.0 );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}`,Fe={alphahash_fragment:lC,alphahash_pars_fragment:uC,alphamap_fragment:cC,alphamap_pars_fragment:fC,alphatest_fragment:dC,alphatest_pars_fragment:hC,aomap_fragment:pC,aomap_pars_fragment:mC,batching_pars_vertex:gC,batching_vertex:xC,begin_vertex:vC,beginnormal_vertex:yC,bsdfs:_C,iridescence_fragment:SC,bumpmap_pars_fragment:MC,clipping_planes_fragment:bC,clipping_planes_pars_fragment:CC,clipping_planes_pars_vertex:LC,clipping_planes_vertex:AC,color_fragment:TC,color_pars_fragment:IC,color_pars_vertex:EC,color_vertex:wC,common:RC,cube_uv_reflection_fragment:DC,defaultnormal_vertex:PC,displacementmap_pars_vertex:UC,displacementmap_vertex:BC,emissivemap_fragment:OC,emissivemap_pars_fragment:NC,colorspace_fragment:FC,colorspace_pars_fragment:zC,envmap_fragment:kC,envmap_common_pars_fragment:HC,envmap_pars_fragment:VC,envmap_pars_vertex:GC,envmap_physical_pars_fragment:eL,envmap_vertex:qC,fog_vertex:WC,fog_pars_vertex:XC,fog_fragment:YC,fog_pars_fragment:ZC,gradientmap_pars_fragment:KC,lightmap_pars_fragment:JC,lights_lambert_fragment:QC,lights_lambert_pars_fragment:jC,lights_pars_begin:$C,lights_toon_fragment:tL,lights_toon_pars_fragment:aL,lights_phong_fragment:nL,lights_phong_pars_fragment:iL,lights_physical_fragment:sL,lights_physical_pars_fragment:rL,lights_fragment_begin:oL,lights_fragment_maps:lL,lights_fragment_end:uL,lightprobes_pars_fragment:cL,logdepthbuf_fragment:fL,logdepthbuf_pars_fragment:dL,logdepthbuf_pars_vertex:hL,logdepthbuf_vertex:pL,map_fragment:mL,map_pars_fragment:gL,map_particle_fragment:xL,map_particle_pars_fragment:vL,metalnessmap_fragment:yL,metalnessmap_pars_fragment:_L,morphinstance_vertex:SL,morphcolor_vertex:ML,morphnormal_vertex:bL,morphtarget_pars_vertex:CL,morphtarget_vertex:LL,normal_fragment_begin:AL,normal_fragment_maps:TL,normal_pars_fragment:IL,normal_pars_vertex:EL,normal_vertex:wL,normalmap_pars_fragment:RL,clearcoat_normal_fragment_begin:DL,clearcoat_normal_fragment_maps:PL,clearcoat_pars_fragment:UL,iridescence_pars_fragment:BL,opaque_fragment:OL,packing:NL,premultiplied_alpha_fragment:FL,project_vertex:zL,dithering_fragment:kL,dithering_pars_fragment:HL,roughnessmap_fragment:VL,roughnessmap_pars_fragment:GL,shadowmap_pars_fragment:qL,shadowmap_pars_vertex:WL,shadowmap_vertex:XL,shadowmask_pars_fragment:YL,skinbase_vertex:ZL,skinning_pars_vertex:KL,skinning_vertex:JL,skinnormal_vertex:QL,specularmap_fragment:jL,specularmap_pars_fragment:$L,tonemapping_fragment:eA,tonemapping_pars_fragment:tA,transmission_fragment:aA,transmission_pars_fragment:nA,uv_pars_fragment:iA,uv_pars_vertex:sA,uv_vertex:rA,worldpos_vertex:oA,background_vert:lA,background_frag:uA,backgroundCube_vert:cA,backgroundCube_frag:fA,cube_vert:dA,cube_frag:hA,depth_vert:pA,depth_frag:mA,distance_vert:gA,distance_frag:xA,equirect_vert:vA,equirect_frag:yA,linedashed_vert:_A,linedashed_frag:SA,meshbasic_vert:MA,meshbasic_frag:bA,meshlambert_vert:CA,meshlambert_frag:LA,meshmatcap_vert:AA,meshmatcap_frag:TA,meshnormal_vert:IA,meshnormal_frag:EA,meshphong_vert:wA,meshphong_frag:RA,meshphysical_vert:DA,meshphysical_frag:PA,meshtoon_vert:UA,meshtoon_frag:BA,points_vert:OA,points_frag:NA,shadow_vert:FA,shadow_frag:zA,sprite_vert:kA,sprite_frag:HA},ce={common:{diffuse:{value:new Je(16777215)},opacity:{value:1},map:{value:null},mapTransform:{value:new De},alphaMap:{value:null},alphaMapTransform:{value:new De},alphaTest:{value:0}},specularmap:{specularMap:{value:null},specularMapTransform:{value:new De}},envmap:{envMap:{value:null},envMapRotation:{value:new De},reflectivity:{value:1},ior:{value:1.5},refractionRatio:{value:.98},dfgLUT:{value:null}},aomap:{aoMap:{value:null},aoMapIntensity:{value:1},aoMapTransform:{value:new De}},lightmap:{lightMap:{value:null},lightMapIntensity:{value:1},lightMapTransform:{value:new De}},bumpmap:{bumpMap:{value:null},bumpMapTransform:{value:new De},bumpScale:{value:1}},normalmap:{normalMap:{value:null},normalMapTransform:{value:new De},normalScale:{value:new qe(1,1)}},displacementmap:{displacementMap:{value:null},displacementMapTransform:{value:new De},displacementScale:{value:1},displacementBias:{value:0}},emissivemap:{emissiveMap:{value:null},emissiveMapTransform:{value:new De}},metalnessmap:{metalnessMap:{value:null},metalnessMapTransform:{value:new De}},roughnessmap:{roughnessMap:{value:null},roughnessMapTransform:{value:new De}},gradientmap:{gradientMap:{value:null}},fog:{fogDensity:{value:25e-5},fogNear:{value:1},fogFar:{value:2e3},fogColor:{value:new Je(16777215)}},lights:{ambientLightColor:{value:[]},lightProbe:{value:[]},directionalLights:{value:[],properties:{direction:{},color:{}}},directionalLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},directionalShadowMatrix:{value:[]},spotLights:{value:[],properties:{color:{},position:{},direction:{},distance:{},coneCos:{},penumbraCos:{},decay:{}}},spotLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},spotLightMap:{value:[]},spotLightMatrix:{value:[]},pointLights:{value:[],properties:{color:{},position:{},decay:{},distance:{}}},pointLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{},shadowCameraNear:{},shadowCameraFar:{}}},pointShadowMatrix:{value:[]},hemisphereLights:{value:[],properties:{direction:{},skyColor:{},groundColor:{}}},rectAreaLights:{value:[],properties:{color:{},position:{},width:{},height:{}}},ltc_1:{value:null},ltc_2:{value:null},probesSH:{value:null},probesMin:{value:new F},probesMax:{value:new F},probesResolution:{value:new F}},points:{diffuse:{value:new Je(16777215)},opacity:{value:1},size:{value:1},scale:{value:1},map:{value:null},alphaMap:{value:null},alphaMapTransform:{value:new De},alphaTest:{value:0},uvTransform:{value:new De}},sprite:{diffuse:{value:new Je(16777215)},opacity:{value:1},center:{value:new qe(.5,.5)},rotation:{value:0},map:{value:null},mapTransform:{value:new De},alphaMap:{value:null},alphaMapTransform:{value:new De},alphaTest:{value:0}}},kn={basic:{uniforms:pa([ce.common,ce.specularmap,ce.envmap,ce.aomap,ce.lightmap,ce.fog]),vertexShader:Fe.meshbasic_vert,fragmentShader:Fe.meshbasic_frag},lambert:{uniforms:pa([ce.common,ce.specularmap,ce.envmap,ce.aomap,ce.lightmap,ce.emissivemap,ce.bumpmap,ce.normalmap,ce.displacementmap,ce.fog,ce.lights,{emissive:{value:new Je(0)},envMapIntensity:{value:1}}]),vertexShader:Fe.meshlambert_vert,fragmentShader:Fe.meshlambert_frag},phong:{uniforms:pa([ce.common,ce.specularmap,ce.envmap,ce.aomap,ce.lightmap,ce.emissivemap,ce.bumpmap,ce.normalmap,ce.displacementmap,ce.fog,ce.lights,{emissive:{value:new Je(0)},specular:{value:new Je(1118481)},shininess:{value:30},envMapIntensity:{value:1}}]),vertexShader:Fe.meshphong_vert,fragmentShader:Fe.meshphong_frag},standard:{uniforms:pa([ce.common,ce.envmap,ce.aomap,ce.lightmap,ce.emissivemap,ce.bumpmap,ce.normalmap,ce.displacementmap,ce.roughnessmap,ce.metalnessmap,ce.fog,ce.lights,{emissive:{value:new Je(0)},roughness:{value:1},metalness:{value:0},envMapIntensity:{value:1}}]),vertexShader:Fe.meshphysical_vert,fragmentShader:Fe.meshphysical_frag},toon:{uniforms:pa([ce.common,ce.aomap,ce.lightmap,ce.emissivemap,ce.bumpmap,ce.normalmap,ce.displacementmap,ce.gradientmap,ce.fog,ce.lights,{emissive:{value:new Je(0)}}]),vertexShader:Fe.meshtoon_vert,fragmentShader:Fe.meshtoon_frag},matcap:{uniforms:pa([ce.common,ce.bumpmap,ce.normalmap,ce.displacementmap,ce.fog,{matcap:{value:null}}]),vertexShader:Fe.meshmatcap_vert,fragmentShader:Fe.meshmatcap_frag},points:{uniforms:pa([ce.points,ce.fog]),vertexShader:Fe.points_vert,fragmentShader:Fe.points_frag},dashed:{uniforms:pa([ce.common,ce.fog,{scale:{value:1},dashSize:{value:1},totalSize:{value:2}}]),vertexShader:Fe.linedashed_vert,fragmentShader:Fe.linedashed_frag},depth:{uniforms:pa([ce.common,ce.displacementmap]),vertexShader:Fe.depth_vert,fragmentShader:Fe.depth_frag},normal:{uniforms:pa([ce.common,ce.bumpmap,ce.normalmap,ce.displacementmap,{opacity:{value:1}}]),vertexShader:Fe.meshnormal_vert,fragmentShader:Fe.meshnormal_frag},sprite:{uniforms:pa([ce.sprite,ce.fog]),vertexShader:Fe.sprite_vert,fragmentShader:Fe.sprite_frag},background:{uniforms:{uvTransform:{value:new De},t2D:{value:null},backgroundIntensity:{value:1}},vertexShader:Fe.background_vert,fragmentShader:Fe.background_frag},backgroundCube:{uniforms:{envMap:{value:null},backgroundBlurriness:{value:0},backgroundIntensity:{value:1},backgroundRotation:{value:new De}},vertexShader:Fe.backgroundCube_vert,fragmentShader:Fe.backgroundCube_frag},cube:{uniforms:{tCube:{value:null},tFlip:{value:-1},opacity:{value:1}},vertexShader:Fe.cube_vert,fragmentShader:Fe.cube_frag},equirect:{uniforms:{tEquirect:{value:null}},vertexShader:Fe.equirect_vert,fragmentShader:Fe.equirect_frag},distance:{uniforms:pa([ce.common,ce.displacementmap,{referencePosition:{value:new F},nearDistance:{value:1},farDistance:{value:1e3}}]),vertexShader:Fe.distance_vert,fragmentShader:Fe.distance_frag},shadow:{uniforms:pa([ce.lights,ce.fog,{color:{value:new Je(0)},opacity:{value:1}}]),vertexShader:Fe.shadow_vert,fragmentShader:Fe.shadow_frag}};kn.physical={uniforms:pa([kn.standard.uniforms,{clearcoat:{value:0},clearcoatMap:{value:null},clearcoatMapTransform:{value:new De},clearcoatNormalMap:{value:null},clearcoatNormalMapTransform:{value:new De},clearcoatNormalScale:{value:new qe(1,1)},clearcoatRoughness:{value:0},clearcoatRoughnessMap:{value:null},clearcoatRoughnessMapTransform:{value:new De},dispersion:{value:0},iridescence:{value:0},iridescenceMap:{value:null},iridescenceMapTransform:{value:new De},iridescenceIOR:{value:1.3},iridescenceThicknessMinimum:{value:100},iridescenceThicknessMaximum:{value:400},iridescenceThicknessMap:{value:null},iridescenceThicknessMapTransform:{value:new De},sheen:{value:0},sheenColor:{value:new Je(0)},sheenColorMap:{value:null},sheenColorMapTransform:{value:new De},sheenRoughness:{value:1},sheenRoughnessMap:{value:null},sheenRoughnessMapTransform:{value:new De},transmission:{value:0},transmissionMap:{value:null},transmissionMapTransform:{value:new De},transmissionSamplerSize:{value:new qe},transmissionSamplerMap:{value:null},thickness:{value:0},thicknessMap:{value:null},thicknessMapTransform:{value:new De},attenuationDistance:{value:0},attenuationColor:{value:new Je(0)},specularColor:{value:new Je(1,1,1)},specularColorMap:{value:null},specularColorMapTransform:{value:new De},specularIntensity:{value:1},specularIntensityMap:{value:null},specularIntensityMapTransform:{value:new De},anisotropyVector:{value:new qe},anisotropyMap:{value:null},anisotropyMapTransform:{value:new De}}]),vertexShader:Fe.meshphysical_vert,fragmentShader:Fe.meshphysical_frag};var nf={r:0,b:0,g:0},VA=new Ot,j0=new De;j0.set(-1,0,0,0,1,0,0,0,1);function GA(t,e,a,n,i,s){let r=new Je(0),o=i===!0?0:1,l,u,d=null,p=0,c=null;function h(x){let S=x.isScene===!0?x.background:null;if(S&&S.isTexture){let _=x.backgroundBlurriness>0;S=e.get(S,_)}return S}function v(x){let S=!1,_=h(x);_===null?m(r,o):_&&_.isColor&&(m(_,1),S=!0);let L=t.xr.getEnvironmentBlendMode();L==="additive"?a.buffers.color.setClear(0,0,0,1,s):L==="alpha-blend"&&a.buffers.color.setClear(0,0,0,0,s),(t.autoClear||S)&&(a.buffers.depth.setTest(!0),a.buffers.depth.setMask(!0),a.buffers.color.setMask(!0),t.clear(t.autoClearColor,t.autoClearDepth,t.autoClearStencil))}function b(x,S){let _=h(S);_&&(_.isCubeTexture||_.mapping===Jo)?(u===void 0&&(u=new La(new Lr(1,1,1),new xa({name:"BackgroundCubeMaterial",uniforms:Bs(kn.backgroundCube.uniforms),vertexShader:kn.backgroundCube.vertexShader,fragmentShader:kn.backgroundCube.fragmentShader,side:va,depthTest:!1,depthWrite:!1,fog:!1,allowOverride:!1})),u.geometry.deleteAttribute("normal"),u.geometry.deleteAttribute("uv"),u.onBeforeRender=function(L,C,T){this.matrixWorld.copyPosition(T.matrixWorld)},Object.defineProperty(u.material,"envMap",{get:function(){return this.uniforms.envMap.value}}),n.update(u)),u.material.uniforms.envMap.value=_,u.material.uniforms.backgroundBlurriness.value=S.backgroundBlurriness,u.material.uniforms.backgroundIntensity.value=S.backgroundIntensity,u.material.uniforms.backgroundRotation.value.setFromMatrix4(VA.makeRotationFromEuler(S.backgroundRotation)).transpose(),_.isCubeTexture&&_.isRenderTargetTexture===!1&&u.material.uniforms.backgroundRotation.value.premultiply(j0),u.material.toneMapped=Ge.getTransfer(_.colorSpace)!==at,(d!==_||p!==_.version||c!==t.toneMapping)&&(u.material.needsUpdate=!0,d=_,p=_.version,c=t.toneMapping),u.layers.enableAll(),x.unshift(u,u.geometry,u.material,0,0,null)):_&&_.isTexture&&(l===void 0&&(l=new La(new Ps(2,2),new xa({name:"BackgroundMaterial",uniforms:Bs(kn.background.uniforms),vertexShader:kn.background.vertexShader,fragmentShader:kn.background.fragmentShader,side:ai,depthTest:!1,depthWrite:!1,fog:!1,allowOverride:!1})),l.geometry.deleteAttribute("normal"),Object.defineProperty(l.material,"map",{get:function(){return this.uniforms.t2D.value}}),n.update(l)),l.material.uniforms.t2D.value=_,l.material.uniforms.backgroundIntensity.value=S.backgroundIntensity,l.material.toneMapped=Ge.getTransfer(_.colorSpace)!==at,_.matrixAutoUpdate===!0&&_.updateMatrix(),l.material.uniforms.uvTransform.value.copy(_.matrix),(d!==_||p!==_.version||c!==t.toneMapping)&&(l.material.needsUpdate=!0,d=_,p=_.version,c=t.toneMapping),l.layers.enableAll(),x.unshift(l,l.geometry,l.material,0,0,null))}function m(x,S){x.getRGB(nf,ep(t)),a.buffers.color.setClear(nf.r,nf.g,nf.b,S,s)}function f(){u!==void 0&&(u.geometry.dispose(),u.material.dispose(),u=void 0),l!==void 0&&(l.geometry.dispose(),l.material.dispose(),l=void 0)}return{getClearColor:function(){return r},setClearColor:function(x,S=1){r.set(x),o=S,m(r,o)},getClearAlpha:function(){return o},setClearAlpha:function(x){o=x,m(r,o)},render:v,addToRenderList:b,dispose:f}}function qA(t,e){let a=t.getParameter(t.MAX_VERTEX_ATTRIBS),n={},i=c(null),s=i,r=!1;function o(w,B,X,K,z){let W=!1,V=p(w,K,X,B);s!==V&&(s=V,u(s.object)),W=h(w,K,X,z),W&&v(w,K,X,z),z!==null&&e.update(z,t.ELEMENT_ARRAY_BUFFER),(W||r)&&(r=!1,_(w,B,X,K),z!==null&&t.bindBuffer(t.ELEMENT_ARRAY_BUFFER,e.get(z).buffer))}function l(){return t.createVertexArray()}function u(w){return t.bindVertexArray(w)}function d(w){return t.deleteVertexArray(w)}function p(w,B,X,K){let z=K.wireframe===!0,W=n[B.id];W===void 0&&(W={},n[B.id]=W);let V=w.isInstancedMesh===!0?w.id:0,j=W[V];j===void 0&&(j={},W[V]=j);let ee=j[X.id];ee===void 0&&(ee={},j[X.id]=ee);let fe=ee[z];return fe===void 0&&(fe=c(l()),ee[z]=fe),fe}function c(w){let B=[],X=[],K=[];for(let z=0;z<a;z++)B[z]=0,X[z]=0,K[z]=0;return{geometry:null,program:null,wireframe:!1,newAttributes:B,enabledAttributes:X,attributeDivisors:K,object:w,attributes:{},index:null}}function h(w,B,X,K){let z=s.attributes,W=B.attributes,V=0,j=X.getAttributes();for(let ee in j)if(j[ee].location>=0){let me=z[ee],ve=W[ee];if(ve===void 0&&(ee==="instanceMatrix"&&w.instanceMatrix&&(ve=w.instanceMatrix),ee==="instanceColor"&&w.instanceColor&&(ve=w.instanceColor)),me===void 0||me.attribute!==ve||ve&&me.data!==ve.data)return!0;V++}return s.attributesNum!==V||s.index!==K}function v(w,B,X,K){let z={},W=B.attributes,V=0,j=X.getAttributes();for(let ee in j)if(j[ee].location>=0){let me=W[ee];me===void 0&&(ee==="instanceMatrix"&&w.instanceMatrix&&(me=w.instanceMatrix),ee==="instanceColor"&&w.instanceColor&&(me=w.instanceColor));let ve={};ve.attribute=me,me&&me.data&&(ve.data=me.data),z[ee]=ve,V++}s.attributes=z,s.attributesNum=V,s.index=K}function b(){let w=s.newAttributes;for(let B=0,X=w.length;B<X;B++)w[B]=0}function m(w){f(w,0)}function f(w,B){let X=s.newAttributes,K=s.enabledAttributes,z=s.attributeDivisors;X[w]=1,K[w]===0&&(t.enableVertexAttribArray(w),K[w]=1),z[w]!==B&&(t.vertexAttribDivisor(w,B),z[w]=B)}function x(){let w=s.newAttributes,B=s.enabledAttributes;for(let X=0,K=B.length;X<K;X++)B[X]!==w[X]&&(t.disableVertexAttribArray(X),B[X]=0)}function S(w,B,X,K,z,W,V){V===!0?t.vertexAttribIPointer(w,B,X,z,W):t.vertexAttribPointer(w,B,X,K,z,W)}function _(w,B,X,K){b();let z=K.attributes,W=X.getAttributes(),V=B.defaultAttributeValues;for(let j in W){let ee=W[j];if(ee.location>=0){let fe=z[j];if(fe===void 0&&(j==="instanceMatrix"&&w.instanceMatrix&&(fe=w.instanceMatrix),j==="instanceColor"&&w.instanceColor&&(fe=w.instanceColor)),fe!==void 0){let me=fe.normalized,ve=fe.itemSize,Qe=e.get(fe);if(Qe===void 0)continue;let Tt=Qe.buffer,je=Qe.type,J=Qe.bytesPerElement,ie=je===t.INT||je===t.UNSIGNED_INT||fe.gpuType===yc;if(fe.isInterleavedBufferAttribute){let te=fe.data,Re=te.stride,Ue=fe.offset;if(te.isInstancedInterleavedBuffer){for(let Te=0;Te<ee.locationSize;Te++)f(ee.location+Te,te.meshPerAttribute);w.isInstancedMesh!==!0&&K._maxInstanceCount===void 0&&(K._maxInstanceCount=te.meshPerAttribute*te.count)}else for(let Te=0;Te<ee.locationSize;Te++)m(ee.location+Te);t.bindBuffer(t.ARRAY_BUFFER,Tt);for(let Te=0;Te<ee.locationSize;Te++)S(ee.location+Te,ve/ee.locationSize,je,me,Re*J,(Ue+ve/ee.locationSize*Te)*J,ie)}else{if(fe.isInstancedBufferAttribute){for(let te=0;te<ee.locationSize;te++)f(ee.location+te,fe.meshPerAttribute);w.isInstancedMesh!==!0&&K._maxInstanceCount===void 0&&(K._maxInstanceCount=fe.meshPerAttribute*fe.count)}else for(let te=0;te<ee.locationSize;te++)m(ee.location+te);t.bindBuffer(t.ARRAY_BUFFER,Tt);for(let te=0;te<ee.locationSize;te++)S(ee.location+te,ve/ee.locationSize,je,me,ve*J,ve/ee.locationSize*te*J,ie)}}else if(V!==void 0){let me=V[j];if(me!==void 0)switch(me.length){case 2:t.vertexAttrib2fv(ee.location,me);break;case 3:t.vertexAttrib3fv(ee.location,me);break;case 4:t.vertexAttrib4fv(ee.location,me);break;default:t.vertexAttrib1fv(ee.location,me)}}}}x()}function L(){A();for(let w in n){let B=n[w];for(let X in B){let K=B[X];for(let z in K){let W=K[z];for(let V in W)d(W[V].object),delete W[V];delete K[z]}}delete n[w]}}function C(w){if(n[w.id]===void 0)return;let B=n[w.id];for(let X in B){let K=B[X];for(let z in K){let W=K[z];for(let V in W)d(W[V].object),delete W[V];delete K[z]}}delete n[w.id]}function T(w){for(let B in n){let X=n[B];for(let K in X){let z=X[K];if(z[w.id]===void 0)continue;let W=z[w.id];for(let V in W)d(W[V].object),delete W[V];delete z[w.id]}}}function y(w){for(let B in n){let X=n[B],K=w.isInstancedMesh===!0?w.id:0,z=X[K];if(z!==void 0){for(let W in z){let V=z[W];for(let j in V)d(V[j].object),delete V[j];delete z[W]}delete X[K],Object.keys(X).length===0&&delete n[B]}}}function A(){E(),r=!0,s!==i&&(s=i,u(s.object))}function E(){i.geometry=null,i.program=null,i.wireframe=!1}return{setup:o,reset:A,resetDefaultState:E,dispose:L,releaseStatesOfGeometry:C,releaseStatesOfObject:y,releaseStatesOfProgram:T,initAttributes:b,enableAttribute:m,disableUnusedAttributes:x}}function WA(t,e,a){let n;function i(l){n=l}function s(l,u){t.drawArrays(n,l,u),a.update(u,n,1)}function r(l,u,d){d!==0&&(t.drawArraysInstanced(n,l,u,d),a.update(u,n,d))}function o(l,u,d){if(d===0)return;e.get("WEBGL_multi_draw").multiDrawArraysWEBGL(n,l,0,u,0,d);let c=0;for(let h=0;h<d;h++)c+=u[h];a.update(c,n,1)}this.setMode=i,this.render=s,this.renderInstances=r,this.renderMultiDraw=o}function XA(t,e,a,n){let i;function s(){if(i!==void 0)return i;if(e.has("EXT_texture_filter_anisotropic")===!0){let T=e.get("EXT_texture_filter_anisotropic");i=t.getParameter(T.MAX_TEXTURE_MAX_ANISOTROPY_EXT)}else i=0;return i}function r(T){return!(T!==tn&&n.convert(T)!==t.getParameter(t.IMPLEMENTATION_COLOR_READ_FORMAT))}function o(T){let y=T===Fn&&(e.has("EXT_color_buffer_half_float")||e.has("EXT_color_buffer_float"));return!(T!==ka&&n.convert(T)!==t.getParameter(t.IMPLEMENTATION_COLOR_READ_TYPE)&&T!==_n&&!y)}function l(T){if(T==="highp"){if(t.getShaderPrecisionFormat(t.VERTEX_SHADER,t.HIGH_FLOAT).precision>0&&t.getShaderPrecisionFormat(t.FRAGMENT_SHADER,t.HIGH_FLOAT).precision>0)return"highp";T="mediump"}return T==="mediump"&&t.getShaderPrecisionFormat(t.VERTEX_SHADER,t.MEDIUM_FLOAT).precision>0&&t.getShaderPrecisionFormat(t.FRAGMENT_SHADER,t.MEDIUM_FLOAT).precision>0?"mediump":"lowp"}let u=a.precision!==void 0?a.precision:"highp",d=l(u);d!==u&&(Ae("WebGLRenderer:",u,"not supported, using",d,"instead."),u=d);let p=a.logarithmicDepthBuffer===!0,c=a.reversedDepthBuffer===!0&&e.has("EXT_clip_control");a.reversedDepthBuffer===!0&&c===!1&&Ae("WebGLRenderer: Unable to use reversed depth buffer due to missing EXT_clip_control extension. Fallback to default depth buffer.");let h=t.getParameter(t.MAX_TEXTURE_IMAGE_UNITS),v=t.getParameter(t.MAX_VERTEX_TEXTURE_IMAGE_UNITS),b=t.getParameter(t.MAX_TEXTURE_SIZE),m=t.getParameter(t.MAX_CUBE_MAP_TEXTURE_SIZE),f=t.getParameter(t.MAX_VERTEX_ATTRIBS),x=t.getParameter(t.MAX_VERTEX_UNIFORM_VECTORS),S=t.getParameter(t.MAX_VARYING_VECTORS),_=t.getParameter(t.MAX_FRAGMENT_UNIFORM_VECTORS),L=t.getParameter(t.MAX_SAMPLES),C=t.getParameter(t.SAMPLES);return{isWebGL2:!0,getMaxAnisotropy:s,getMaxPrecision:l,textureFormatReadable:r,textureTypeReadable:o,precision:u,logarithmicDepthBuffer:p,reversedDepthBuffer:c,maxTextures:h,maxVertexTextures:v,maxTextureSize:b,maxCubemapSize:m,maxAttributes:f,maxVertexUniforms:x,maxVaryings:S,maxFragmentUniforms:_,maxSamples:L,samples:C}}function YA(t){let e=this,a=null,n=0,i=!1,s=!1,r=new wn,o=new De,l={value:null,needsUpdate:!1};this.uniform=l,this.numPlanes=0,this.numIntersection=0,this.init=function(p,c){let h=p.length!==0||c||n!==0||i;return i=c,n=p.length,h},this.beginShadows=function(){s=!0,d(null)},this.endShadows=function(){s=!1},this.setGlobalState=function(p,c){a=d(p,c,0)},this.setState=function(p,c,h){let v=p.clippingPlanes,b=p.clipIntersection,m=p.clipShadows,f=t.get(p);if(!i||v===null||v.length===0||s&&!m)s?d(null):u();else{let x=s?0:n,S=x*4,_=f.clippingState||null;l.value=_,_=d(v,c,S,h);for(let L=0;L!==S;++L)_[L]=a[L];f.clippingState=_,this.numIntersection=b?this.numPlanes:0,this.numPlanes+=x}};function u(){l.value!==a&&(l.value=a,l.needsUpdate=n>0),e.numPlanes=n,e.numIntersection=0}function d(p,c,h,v){let b=p!==null?p.length:0,m=null;if(b!==0){if(m=l.value,v!==!0||m===null){let f=h+b*4,x=c.matrixWorldInverse;o.getNormalMatrix(x),(m===null||m.length<f)&&(m=new Float32Array(f));for(let S=0,_=h;S!==b;++S,_+=4)r.copy(p[S]).applyMatrix4(x,o),r.normal.toArray(m,_),m[_+3]=r.constant}l.value=m,l.needsUpdate=!0}return e.numPlanes=b,e.numIntersection=0,m}}var Yi=4,E0=[.125,.215,.35,.446,.526,.582],Os=20,ZA=256,sl=new Yo,w0=new Je,ip=null,sp=0,rp=0,op=!1,KA=new F,rf=class{constructor(e){this._renderer=e,this._pingPongRenderTarget=null,this._lodMax=0,this._cubeSize=0,this._sizeLods=[],this._sigmas=[],this._lodMeshes=[],this._backgroundBox=null,this._cubemapMaterial=null,this._equirectMaterial=null,this._blurMaterial=null,this._ggxMaterial=null}fromScene(e,a=0,n=.1,i=100,s={}){let{size:r=256,position:o=KA}=s;ip=this._renderer.getRenderTarget(),sp=this._renderer.getActiveCubeFace(),rp=this._renderer.getActiveMipmapLevel(),op=this._renderer.xr.enabled,this._renderer.xr.enabled=!1,this._setSize(r);let l=this._allocateTargets();return l.depthBuffer=!0,this._sceneToCubeUV(e,n,i,l,o),a>0&&this._blur(l,0,0,a),this._applyPMREM(l),this._cleanup(l),l}fromEquirectangular(e,a=null){return this._fromTexture(e,a)}fromCubemap(e,a=null){return this._fromTexture(e,a)}compileCubemapShader(){this._cubemapMaterial===null&&(this._cubemapMaterial=P0(),this._compileMaterial(this._cubemapMaterial))}compileEquirectangularShader(){this._equirectMaterial===null&&(this._equirectMaterial=D0(),this._compileMaterial(this._equirectMaterial))}dispose(){this._dispose(),this._cubemapMaterial!==null&&this._cubemapMaterial.dispose(),this._equirectMaterial!==null&&this._equirectMaterial.dispose(),this._backgroundBox!==null&&(this._backgroundBox.geometry.dispose(),this._backgroundBox.material.dispose())}_setSize(e){this._lodMax=Math.floor(Math.log2(e)),this._cubeSize=Math.pow(2,this._lodMax)}_dispose(){this._blurMaterial!==null&&this._blurMaterial.dispose(),this._ggxMaterial!==null&&this._ggxMaterial.dispose(),this._pingPongRenderTarget!==null&&this._pingPongRenderTarget.dispose();for(let e=0;e<this._lodMeshes.length;e++)this._lodMeshes[e].geometry.dispose()}_cleanup(e){this._renderer.setRenderTarget(ip,sp,rp),this._renderer.xr.enabled=op,e.scissorTest=!1,Er(e,0,0,e.width,e.height)}_fromTexture(e,a){e.mapping===Gi||e.mapping===Us?this._setSize(e.image.length===0?16:e.image[0].width||e.image[0].image.width):this._setSize(e.image.width/4),ip=this._renderer.getRenderTarget(),sp=this._renderer.getActiveCubeFace(),rp=this._renderer.getActiveMipmapLevel(),op=this._renderer.xr.enabled,this._renderer.xr.enabled=!1;let n=a||this._allocateTargets();return this._textureToCubeUV(e,n),this._applyPMREM(n),this._cleanup(n),n}_allocateTargets(){let e=3*Math.max(this._cubeSize,112),a=4*this._cubeSize,n={magFilter:ia,minFilter:ia,generateMipmaps:!1,type:Fn,format:tn,colorSpace:Do,depthBuffer:!1},i=R0(e,a,n);if(this._pingPongRenderTarget===null||this._pingPongRenderTarget.width!==e||this._pingPongRenderTarget.height!==a){this._pingPongRenderTarget!==null&&this._dispose(),this._pingPongRenderTarget=R0(e,a,n);let{_lodMax:s}=this;({lodMeshes:this._lodMeshes,sizeLods:this._sizeLods,sigmas:this._sigmas}=JA(s)),this._blurMaterial=jA(s,e,a),this._ggxMaterial=QA(s,e,a)}return i}_compileMaterial(e){let a=new La(new Bn,e);this._renderer.compile(a,sl)}_sceneToCubeUV(e,a,n,i,s){let l=new ha(90,1,a,n),u=[1,-1,1,1,1,1],d=[1,1,1,-1,-1,-1],p=this._renderer,c=p.autoClear,h=p.toneMapping;p.getClearColor(w0),p.toneMapping=vn,p.autoClear=!1,p.state.buffers.depth.getReversed()&&(p.setRenderTarget(i),p.clearDepth(),p.setRenderTarget(null)),this._backgroundBox===null&&(this._backgroundBox=new La(new Lr,new Ho({name:"PMREM.Background",side:va,depthWrite:!1,depthTest:!1})));let b=this._backgroundBox,m=b.material,f=!1,x=e.background;x?x.isColor&&(m.color.copy(x),e.background=null,f=!0):(m.color.copy(w0),f=!0);for(let S=0;S<6;S++){let _=S%3;_===0?(l.up.set(0,u[S],0),l.position.set(s.x,s.y,s.z),l.lookAt(s.x+d[S],s.y,s.z)):_===1?(l.up.set(0,0,u[S]),l.position.set(s.x,s.y,s.z),l.lookAt(s.x,s.y+d[S],s.z)):(l.up.set(0,u[S],0),l.position.set(s.x,s.y,s.z),l.lookAt(s.x,s.y,s.z+d[S]));let L=this._cubeSize;Er(i,_*L,S>2?L:0,L,L),p.setRenderTarget(i),f&&p.render(b,l),p.render(e,l)}p.toneMapping=h,p.autoClear=c,e.background=x}_textureToCubeUV(e,a){let n=this._renderer,i=e.mapping===Gi||e.mapping===Us;i?(this._cubemapMaterial===null&&(this._cubemapMaterial=P0()),this._cubemapMaterial.uniforms.flipEnvMap.value=e.isRenderTargetTexture===!1?-1:1):this._equirectMaterial===null&&(this._equirectMaterial=D0());let s=i?this._cubemapMaterial:this._equirectMaterial,r=this._lodMeshes[0];r.material=s;let o=s.uniforms;o.envMap.value=e;let l=this._cubeSize;Er(a,0,0,3*l,2*l),n.setRenderTarget(a),n.render(r,sl)}_applyPMREM(e){let a=this._renderer,n=a.autoClear;a.autoClear=!1;let i=this._lodMeshes.length;for(let s=1;s<i;s++)this._applyGGXFilter(e,s-1,s);a.autoClear=n}_applyGGXFilter(e,a,n){let i=this._renderer,s=this._pingPongRenderTarget,r=this._ggxMaterial,o=this._lodMeshes[n];o.material=r;let l=r.uniforms,u=n/(this._lodMeshes.length-1),d=a/(this._lodMeshes.length-1),p=Math.sqrt(u*u-d*d),c=0+u*1.25,h=p*c,{_lodMax:v}=this,b=this._sizeLods[n],m=3*b*(n>v-Yi?n-v+Yi:0),f=4*(this._cubeSize-b);l.envMap.value=e.texture,l.roughness.value=h,l.mipInt.value=v-a,Er(s,m,f,3*b,2*b),i.setRenderTarget(s),i.render(o,sl),l.envMap.value=s.texture,l.roughness.value=0,l.mipInt.value=v-n,Er(e,m,f,3*b,2*b),i.setRenderTarget(e),i.render(o,sl)}_blur(e,a,n,i,s){let r=this._pingPongRenderTarget;this._halfBlur(e,r,a,n,i,"latitudinal",s),this._halfBlur(r,e,n,n,i,"longitudinal",s)}_halfBlur(e,a,n,i,s,r,o){let l=this._renderer,u=this._blurMaterial;r!=="latitudinal"&&r!=="longitudinal"&&Ee("blur direction must be either latitudinal or longitudinal!");let d=3,p=this._lodMeshes[i];p.material=u;let c=u.uniforms,h=this._sizeLods[n]-1,v=isFinite(s)?Math.PI/(2*h):2*Math.PI/(2*Os-1),b=s/v,m=isFinite(s)?1+Math.floor(d*b):Os;m>Os&&Ae(`sigmaRadians, ${s}, is too large and will clip, as it requested ${m} samples when the maximum is set to ${Os}`);let f=[],x=0;for(let T=0;T<Os;++T){let y=T/b,A=Math.exp(-y*y/2);f.push(A),T===0?x+=A:T<m&&(x+=2*A)}for(let T=0;T<f.length;T++)f[T]=f[T]/x;c.envMap.value=e.texture,c.samples.value=m,c.weights.value=f,c.latitudinal.value=r==="latitudinal",o&&(c.poleAxis.value=o);let{_lodMax:S}=this;c.dTheta.value=v,c.mipInt.value=S-n;let _=this._sizeLods[i],L=3*_*(i>S-Yi?i-S+Yi:0),C=4*(this._cubeSize-_);Er(a,L,C,3*_,2*_),l.setRenderTarget(a),l.render(p,sl)}};function JA(t){let e=[],a=[],n=[],i=t,s=t-Yi+1+E0.length;for(let r=0;r<s;r++){let o=Math.pow(2,i);e.push(o);let l=1/o;r>t-Yi?l=E0[r-t+Yi-1]:r===0&&(l=0),a.push(l);let u=1/(o-2),d=-u,p=1+u,c=[d,d,p,d,p,p,d,d,p,p,d,p],h=6,v=6,b=3,m=2,f=1,x=new Float32Array(b*v*h),S=new Float32Array(m*v*h),_=new Float32Array(f*v*h);for(let C=0;C<h;C++){let T=C%3*2/3-1,y=C>2?0:-1,A=[T,y,0,T+2/3,y,0,T+2/3,y+1,0,T,y,0,T+2/3,y+1,0,T,y+1,0];x.set(A,b*v*C),S.set(c,m*v*C);let E=[C,C,C,C,C,C];_.set(E,f*v*C)}let L=new Bn;L.setAttribute("position",new Na(x,b)),L.setAttribute("uv",new Na(S,m)),L.setAttribute("faceIndex",new Na(_,f)),n.push(new La(L,null)),i>Yi&&i--}return{lodMeshes:n,sizeLods:e,sigmas:a}}function R0(t,e,a){let n=new Fa(t,e,a);return n.texture.mapping=Jo,n.texture.name="PMREM.cubeUv",n.scissorTest=!0,n}function Er(t,e,a,n,i){t.viewport.set(e,a,n,i),t.scissor.set(e,a,n,i)}function QA(t,e,a){return new xa({name:"PMREMGGXConvolution",defines:{GGX_SAMPLES:ZA,CUBEUV_TEXEL_WIDTH:1/e,CUBEUV_TEXEL_HEIGHT:1/a,CUBEUV_MAX_MIP:`${t}.0`},uniforms:{envMap:{value:null},roughness:{value:0},mipInt:{value:0}},vertexShader:uf(),fragmentShader:`

			precision highp float;
			precision highp int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;
			uniform float roughness;
			uniform float mipInt;

			#define ENVMAP_TYPE_CUBE_UV
			#include <cube_uv_reflection_fragment>

			#define PI 3.14159265359

			// Van der Corput radical inverse
			float radicalInverse_VdC(uint bits) {
				bits = (bits << 16u) | (bits >> 16u);
				bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
				bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
				bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
				bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
				return float(bits) * 2.3283064365386963e-10; // / 0x100000000
			}

			// Hammersley sequence
			vec2 hammersley(uint i, uint N) {
				return vec2(float(i) / float(N), radicalInverse_VdC(i));
			}

			// GGX VNDF importance sampling (Eric Heitz 2018)
			// "Sampling the GGX Distribution of Visible Normals"
			// https://jcgt.org/published/0007/04/01/
			vec3 importanceSampleGGX_VNDF(vec2 Xi, vec3 V, float roughness) {
				float alpha = roughness * roughness;

				// Section 4.1: Orthonormal basis
				vec3 T1 = vec3(1.0, 0.0, 0.0);
				vec3 T2 = cross(V, T1);

				// Section 4.2: Parameterization of projected area
				float r = sqrt(Xi.x);
				float phi = 2.0 * PI * Xi.y;
				float t1 = r * cos(phi);
				float t2 = r * sin(phi);
				float s = 0.5 * (1.0 + V.z);
				t2 = (1.0 - s) * sqrt(1.0 - t1 * t1) + s * t2;

				// Section 4.3: Reprojection onto hemisphere
				vec3 Nh = t1 * T1 + t2 * T2 + sqrt(max(0.0, 1.0 - t1 * t1 - t2 * t2)) * V;

				// Section 3.4: Transform back to ellipsoid configuration
				return normalize(vec3(alpha * Nh.x, alpha * Nh.y, max(0.0, Nh.z)));
			}

			void main() {
				vec3 N = normalize(vOutputDirection);
				vec3 V = N; // Assume view direction equals normal for pre-filtering

				vec3 prefilteredColor = vec3(0.0);
				float totalWeight = 0.0;

				// For very low roughness, just sample the environment directly
				if (roughness < 0.001) {
					gl_FragColor = vec4(bilinearCubeUV(envMap, N, mipInt), 1.0);
					return;
				}

				// Tangent space basis for VNDF sampling
				vec3 up = abs(N.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
				vec3 tangent = normalize(cross(up, N));
				vec3 bitangent = cross(N, tangent);

				for(uint i = 0u; i < uint(GGX_SAMPLES); i++) {
					vec2 Xi = hammersley(i, uint(GGX_SAMPLES));

					// For PMREM, V = N, so in tangent space V is always (0, 0, 1)
					vec3 H_tangent = importanceSampleGGX_VNDF(Xi, vec3(0.0, 0.0, 1.0), roughness);

					// Transform H back to world space
					vec3 H = normalize(tangent * H_tangent.x + bitangent * H_tangent.y + N * H_tangent.z);
					vec3 L = normalize(2.0 * dot(V, H) * H - V);

					float NdotL = max(dot(N, L), 0.0);

					if(NdotL > 0.0) {
						// Sample environment at fixed mip level
						// VNDF importance sampling handles the distribution filtering
						vec3 sampleColor = bilinearCubeUV(envMap, L, mipInt);

						// Weight by NdotL for the split-sum approximation
						// VNDF PDF naturally accounts for the visible microfacet distribution
						prefilteredColor += sampleColor * NdotL;
						totalWeight += NdotL;
					}
				}

				if (totalWeight > 0.0) {
					prefilteredColor = prefilteredColor / totalWeight;
				}

				gl_FragColor = vec4(prefilteredColor, 1.0);
			}
		`,blending:Nn,depthTest:!1,depthWrite:!1})}function jA(t,e,a){let n=new Float32Array(Os),i=new F(0,1,0);return new xa({name:"SphericalGaussianBlur",defines:{n:Os,CUBEUV_TEXEL_WIDTH:1/e,CUBEUV_TEXEL_HEIGHT:1/a,CUBEUV_MAX_MIP:`${t}.0`},uniforms:{envMap:{value:null},samples:{value:1},weights:{value:n},latitudinal:{value:!1},dTheta:{value:0},mipInt:{value:0},poleAxis:{value:i}},vertexShader:uf(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;
			uniform int samples;
			uniform float weights[ n ];
			uniform bool latitudinal;
			uniform float dTheta;
			uniform float mipInt;
			uniform vec3 poleAxis;

			#define ENVMAP_TYPE_CUBE_UV
			#include <cube_uv_reflection_fragment>

			vec3 getSample( float theta, vec3 axis ) {

				float cosTheta = cos( theta );
				// Rodrigues' axis-angle rotation
				vec3 sampleDirection = vOutputDirection * cosTheta
					+ cross( axis, vOutputDirection ) * sin( theta )
					+ axis * dot( axis, vOutputDirection ) * ( 1.0 - cosTheta );

				return bilinearCubeUV( envMap, sampleDirection, mipInt );

			}

			void main() {

				vec3 axis = latitudinal ? poleAxis : cross( poleAxis, vOutputDirection );

				if ( all( equal( axis, vec3( 0.0 ) ) ) ) {

					axis = vec3( vOutputDirection.z, 0.0, - vOutputDirection.x );

				}

				axis = normalize( axis );

				gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
				gl_FragColor.rgb += weights[ 0 ] * getSample( 0.0, axis );

				for ( int i = 1; i < n; i++ ) {

					if ( i >= samples ) {

						break;

					}

					float theta = dTheta * float( i );
					gl_FragColor.rgb += weights[ i ] * getSample( -1.0 * theta, axis );
					gl_FragColor.rgb += weights[ i ] * getSample( theta, axis );

				}

			}
		`,blending:Nn,depthTest:!1,depthWrite:!1})}function D0(){return new xa({name:"EquirectangularToCubeUV",uniforms:{envMap:{value:null}},vertexShader:uf(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;

			#include <common>

			void main() {

				vec3 outputDirection = normalize( vOutputDirection );
				vec2 uv = equirectUv( outputDirection );

				gl_FragColor = vec4( texture2D ( envMap, uv ).rgb, 1.0 );

			}
		`,blending:Nn,depthTest:!1,depthWrite:!1})}function P0(){return new xa({name:"CubemapToCubeUV",uniforms:{envMap:{value:null},flipEnvMap:{value:-1}},vertexShader:uf(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			uniform float flipEnvMap;

			varying vec3 vOutputDirection;

			uniform samplerCube envMap;

			void main() {

				gl_FragColor = textureCube( envMap, vec3( flipEnvMap * vOutputDirection.x, vOutputDirection.yz ) );

			}
		`,blending:Nn,depthTest:!1,depthWrite:!1})}function uf(){return`

		precision mediump float;
		precision mediump int;

		attribute float faceIndex;

		varying vec3 vOutputDirection;

		// RH coordinate system; PMREM face-indexing convention
		vec3 getDirection( vec2 uv, float face ) {

			uv = 2.0 * uv - 1.0;

			vec3 direction = vec3( uv, 1.0 );

			if ( face == 0.0 ) {

				direction = direction.zyx; // ( 1, v, u ) pos x

			} else if ( face == 1.0 ) {

				direction = direction.xzy;
				direction.xz *= -1.0; // ( -u, 1, -v ) pos y

			} else if ( face == 2.0 ) {

				direction.x *= -1.0; // ( -u, v, 1 ) pos z

			} else if ( face == 3.0 ) {

				direction = direction.zyx;
				direction.xz *= -1.0; // ( -1, v, -u ) neg x

			} else if ( face == 4.0 ) {

				direction = direction.xzy;
				direction.xy *= -1.0; // ( -u, -1, v ) neg y

			} else if ( face == 5.0 ) {

				direction.z *= -1.0; // ( u, v, -1 ) neg z

			}

			return direction;

		}

		void main() {

			vOutputDirection = getDirection( uv, faceIndex );
			gl_Position = vec4( position, 1.0 );

		}
	`}var of=class extends Fa{constructor(e=1,a={}){super(e,e,a),this.isWebGLCubeRenderTarget=!0;let n={width:e,height:e,depth:1},i=[n,n,n,n,n,n];this.texture=new Go(i),this._setTextureOptions(a),this.texture.isRenderTargetTexture=!0}fromEquirectangularTexture(e,a){this.texture.type=a.type,this.texture.colorSpace=a.colorSpace,this.texture.generateMipmaps=a.generateMipmaps,this.texture.minFilter=a.minFilter,this.texture.magFilter=a.magFilter;let n={uniforms:{tEquirect:{value:null}},vertexShader:`

				varying vec3 vWorldDirection;

				vec3 transformDirection( in vec3 dir, in mat4 matrix ) {

					return normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );

				}

				void main() {

					vWorldDirection = transformDirection( position, modelMatrix );

					#include <begin_vertex>
					#include <project_vertex>

				}
			`,fragmentShader:`

				uniform sampler2D tEquirect;

				varying vec3 vWorldDirection;

				#include <common>

				void main() {

					vec3 direction = normalize( vWorldDirection );

					vec2 sampleUV = equirectUv( direction );

					gl_FragColor = texture2D( tEquirect, sampleUV );

				}
			`},i=new Lr(5,5,5),s=new xa({name:"CubemapFromEquirect",uniforms:Bs(n.uniforms),vertexShader:n.vertexShader,fragmentShader:n.fragmentShader,side:va,blending:Nn});s.uniforms.tEquirect.value=a;let r=new La(i,s),o=a.minFilter;return a.minFilter===qi&&(a.minFilter=ia),new pc(1,10,this).update(e,r),a.minFilter=o,r.geometry.dispose(),r.material.dispose(),this}clear(e,a=!0,n=!0,i=!0){let s=e.getRenderTarget();for(let r=0;r<6;r++)e.setRenderTarget(this,r),e.clear(a,n,i);e.setRenderTarget(s)}};function $A(t){let e=new WeakMap,a=new WeakMap,n=null;function i(c,h=!1){return c==null?null:h?r(c):s(c)}function s(c){if(c&&c.isTexture){let h=c.mapping;if(h===gc||h===xc)if(e.has(c)){let v=e.get(c).texture;return o(v,c.mapping)}else{let v=c.image;if(v&&v.height>0){let b=new of(v.height);return b.fromEquirectangularTexture(t,c),e.set(c,b),c.addEventListener("dispose",u),o(b.texture,c.mapping)}else return null}}return c}function r(c){if(c&&c.isTexture){let h=c.mapping,v=h===gc||h===xc,b=h===Gi||h===Us;if(v||b){let m=a.get(c),f=m!==void 0?m.texture.pmremVersion:0;if(c.isRenderTargetTexture&&c.pmremVersion!==f)return n===null&&(n=new rf(t)),m=v?n.fromEquirectangular(c,m):n.fromCubemap(c,m),m.texture.pmremVersion=c.pmremVersion,a.set(c,m),m.texture;if(m!==void 0)return m.texture;{let x=c.image;return v&&x&&x.height>0||b&&x&&l(x)?(n===null&&(n=new rf(t)),m=v?n.fromEquirectangular(c):n.fromCubemap(c),m.texture.pmremVersion=c.pmremVersion,a.set(c,m),c.addEventListener("dispose",d),m.texture):null}}}return c}function o(c,h){return h===gc?c.mapping=Gi:h===xc&&(c.mapping=Us),c}function l(c){let h=0,v=6;for(let b=0;b<v;b++)c[b]!==void 0&&h++;return h===v}function u(c){let h=c.target;h.removeEventListener("dispose",u);let v=e.get(h);v!==void 0&&(e.delete(h),v.dispose())}function d(c){let h=c.target;h.removeEventListener("dispose",d);let v=a.get(h);v!==void 0&&(a.delete(h),v.dispose())}function p(){e=new WeakMap,a=new WeakMap,n!==null&&(n.dispose(),n=null)}return{get:i,dispose:p}}function e1(t){let e={};function a(n){if(e[n]!==void 0)return e[n];let i=t.getExtension(n);return e[n]=i,i}return{has:function(n){return a(n)!==null},init:function(){a("EXT_color_buffer_float"),a("WEBGL_clip_cull_distance"),a("OES_texture_float_linear"),a("EXT_color_buffer_half_float"),a("WEBGL_multisampled_render_to_texture"),a("WEBGL_render_shared_exponent")},get:function(n){let i=a(n);return i===null&&Es("WebGLRenderer: "+n+" extension not supported."),i}}}function t1(t,e,a,n){let i={},s=new WeakMap;function r(p){let c=p.target;c.index!==null&&e.remove(c.index);for(let v in c.attributes)e.remove(c.attributes[v]);c.removeEventListener("dispose",r),delete i[c.id];let h=s.get(c);h&&(e.remove(h),s.delete(c)),n.releaseStatesOfGeometry(c),c.isInstancedBufferGeometry===!0&&delete c._maxInstanceCount,a.memory.geometries--}function o(p,c){return i[c.id]===!0||(c.addEventListener("dispose",r),i[c.id]=!0,a.memory.geometries++),c}function l(p){let c=p.attributes;for(let h in c)e.update(c[h],t.ARRAY_BUFFER)}function u(p){let c=[],h=p.index,v=p.attributes.position,b=0;if(v===void 0)return;if(h!==null){let x=h.array;b=h.version;for(let S=0,_=x.length;S<_;S+=3){let L=x[S+0],C=x[S+1],T=x[S+2];c.push(L,C,C,T,T,L)}}else{let x=v.array;b=v.version;for(let S=0,_=x.length/3-1;S<_;S+=3){let L=S+0,C=S+1,T=S+2;c.push(L,C,C,T,T,L)}}let m=new(v.count>=65535?ko:zo)(c,1);m.version=b;let f=s.get(p);f&&e.remove(f),s.set(p,m)}function d(p){let c=s.get(p);if(c){let h=p.index;h!==null&&c.version<h.version&&u(p)}else u(p);return s.get(p)}return{get:o,update:l,getWireframeAttribute:d}}function a1(t,e,a){let n;function i(p){n=p}let s,r;function o(p){s=p.type,r=p.bytesPerElement}function l(p,c){t.drawElements(n,c,s,p*r),a.update(c,n,1)}function u(p,c,h){h!==0&&(t.drawElementsInstanced(n,c,s,p*r,h),a.update(c,n,h))}function d(p,c,h){if(h===0)return;e.get("WEBGL_multi_draw").multiDrawElementsWEBGL(n,c,0,s,p,0,h);let b=0;for(let m=0;m<h;m++)b+=c[m];a.update(b,n,1)}this.setMode=i,this.setIndex=o,this.render=l,this.renderInstances=u,this.renderMultiDraw=d}function n1(t){let e={geometries:0,textures:0},a={frame:0,calls:0,triangles:0,points:0,lines:0};function n(s,r,o){switch(a.calls++,r){case t.TRIANGLES:a.triangles+=o*(s/3);break;case t.LINES:a.lines+=o*(s/2);break;case t.LINE_STRIP:a.lines+=o*(s-1);break;case t.LINE_LOOP:a.lines+=o*s;break;case t.POINTS:a.points+=o*s;break;default:Ee("WebGLInfo: Unknown draw mode:",r);break}}function i(){a.calls=0,a.triangles=0,a.points=0,a.lines=0}return{memory:e,render:a,programs:null,autoReset:!0,reset:i,update:n}}function i1(t,e,a){let n=new WeakMap,i=new At;function s(r,o,l){let u=r.morphTargetInfluences,d=o.morphAttributes.position||o.morphAttributes.normal||o.morphAttributes.color,p=d!==void 0?d.length:0,c=n.get(o);if(c===void 0||c.count!==p){let A=function(){T.dispose(),n.delete(o),o.removeEventListener("dispose",A)};c!==void 0&&c.texture.dispose();let h=o.morphAttributes.position!==void 0,v=o.morphAttributes.normal!==void 0,b=o.morphAttributes.color!==void 0,m=o.morphAttributes.position||[],f=o.morphAttributes.normal||[],x=o.morphAttributes.color||[],S=0;h===!0&&(S=1),v===!0&&(S=2),b===!0&&(S=3);let _=o.attributes.position.count*S,L=1;_>e.maxTextureSize&&(L=Math.ceil(_/e.maxTextureSize),_=e.maxTextureSize);let C=new Float32Array(_*L*4*p),T=new Oo(C,_,L,p);T.type=_n,T.needsUpdate=!0;let y=S*4;for(let E=0;E<p;E++){let w=m[E],B=f[E],X=x[E],K=_*L*4*E;for(let z=0;z<w.count;z++){let W=z*y;h===!0&&(i.fromBufferAttribute(w,z),C[K+W+0]=i.x,C[K+W+1]=i.y,C[K+W+2]=i.z,C[K+W+3]=0),v===!0&&(i.fromBufferAttribute(B,z),C[K+W+4]=i.x,C[K+W+5]=i.y,C[K+W+6]=i.z,C[K+W+7]=0),b===!0&&(i.fromBufferAttribute(X,z),C[K+W+8]=i.x,C[K+W+9]=i.y,C[K+W+10]=i.z,C[K+W+11]=X.itemSize===4?i.w:1)}}c={count:p,texture:T,size:new qe(_,L)},n.set(o,c),o.addEventListener("dispose",A)}if(r.isInstancedMesh===!0&&r.morphTexture!==null)l.getUniforms().setValue(t,"morphTexture",r.morphTexture,a);else{let h=0;for(let b=0;b<u.length;b++)h+=u[b];let v=o.morphTargetsRelative?1:1-h;l.getUniforms().setValue(t,"morphTargetBaseInfluence",v),l.getUniforms().setValue(t,"morphTargetInfluences",u)}l.getUniforms().setValue(t,"morphTargetsTexture",c.texture,a),l.getUniforms().setValue(t,"morphTargetsTextureSize",c.size)}return{update:s}}function s1(t,e,a,n,i){let s=new WeakMap;function r(u){let d=i.render.frame,p=u.geometry,c=e.get(u,p);if(s.get(c)!==d&&(e.update(c),s.set(c,d)),u.isInstancedMesh&&(u.hasEventListener("dispose",l)===!1&&u.addEventListener("dispose",l),s.get(u)!==d&&(a.update(u.instanceMatrix,t.ARRAY_BUFFER),u.instanceColor!==null&&a.update(u.instanceColor,t.ARRAY_BUFFER),s.set(u,d))),u.isSkinnedMesh){let h=u.skeleton;s.get(h)!==d&&(h.update(),s.set(h,d))}return c}function o(){s=new WeakMap}function l(u){let d=u.target;d.removeEventListener("dispose",l),n.releaseStatesOfObject(d),a.remove(d.instanceMatrix),d.instanceColor!==null&&a.remove(d.instanceColor)}return{update:r,dispose:o}}var r1={[Oh]:"LINEAR_TONE_MAPPING",[Nh]:"REINHARD_TONE_MAPPING",[Fh]:"CINEON_TONE_MAPPING",[zh]:"ACES_FILMIC_TONE_MAPPING",[Hh]:"AGX_TONE_MAPPING",[Vh]:"NEUTRAL_TONE_MAPPING",[kh]:"CUSTOM_TONE_MAPPING"};function o1(t,e,a,n,i,s){let r=new Fa(e,a,{type:t,depthBuffer:i,stencilBuffer:s,samples:n?4:0,depthTexture:i?new ni(e,a):void 0}),o=new Fa(e,a,{type:Fn,depthBuffer:!1,stencilBuffer:!1}),l=new Bn;l.setAttribute("position",new $a([-1,3,0,-1,-1,0,3,-1,0],3)),l.setAttribute("uv",new $a([0,2,0,0,2,0],2));let u=new tc({uniforms:{tDiffuse:{value:null}},vertexShader:`
			precision highp float;

			uniform mat4 modelViewMatrix;
			uniform mat4 projectionMatrix;

			attribute vec3 position;
			attribute vec2 uv;

			varying vec2 vUv;

			void main() {
				vUv = uv;
				gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
			}`,fragmentShader:`
			precision highp float;

			uniform sampler2D tDiffuse;

			varying vec2 vUv;

			#include <tonemapping_pars_fragment>
			#include <colorspace_pars_fragment>

			void main() {
				gl_FragColor = texture2D( tDiffuse, vUv );

				#ifdef LINEAR_TONE_MAPPING
					gl_FragColor.rgb = LinearToneMapping( gl_FragColor.rgb );
				#elif defined( REINHARD_TONE_MAPPING )
					gl_FragColor.rgb = ReinhardToneMapping( gl_FragColor.rgb );
				#elif defined( CINEON_TONE_MAPPING )
					gl_FragColor.rgb = CineonToneMapping( gl_FragColor.rgb );
				#elif defined( ACES_FILMIC_TONE_MAPPING )
					gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );
				#elif defined( AGX_TONE_MAPPING )
					gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );
				#elif defined( NEUTRAL_TONE_MAPPING )
					gl_FragColor.rgb = NeutralToneMapping( gl_FragColor.rgb );
				#elif defined( CUSTOM_TONE_MAPPING )
					gl_FragColor.rgb = CustomToneMapping( gl_FragColor.rgb );
				#endif

				#ifdef SRGB_TRANSFER
					gl_FragColor = sRGBTransferOETF( gl_FragColor );
				#endif
			}`,depthTest:!1,depthWrite:!1}),d=new La(l,u),p=new Yo(-1,1,1,-1,0,1),c=null,h=null,v=!1,b,m=null,f=[],x=!1;this.setSize=function(S,_){r.setSize(S,_),o.setSize(S,_);for(let L=0;L<f.length;L++){let C=f[L];C.setSize&&C.setSize(S,_)}},this.setEffects=function(S){f=S,x=f.length>0&&f[0].isRenderPass===!0;let _=r.width,L=r.height;for(let C=0;C<f.length;C++){let T=f[C];T.setSize&&T.setSize(_,L)}},this.begin=function(S,_){if(v||S.toneMapping===vn&&f.length===0)return!1;if(m=_,_!==null){let L=_.width,C=_.height;(r.width!==L||r.height!==C)&&this.setSize(L,C)}return x===!1&&S.setRenderTarget(r),b=S.toneMapping,S.toneMapping=vn,!0},this.hasRenderPass=function(){return x},this.end=function(S,_){S.toneMapping=b,v=!0;let L=r,C=o;for(let T=0;T<f.length;T++){let y=f[T];if(y.enabled!==!1&&(y.render(S,C,L,_),y.needsSwap!==!1)){let A=L;L=C,C=A}}if(c!==S.outputColorSpace||h!==S.toneMapping){c=S.outputColorSpace,h=S.toneMapping,u.defines={},Ge.getTransfer(c)===at&&(u.defines.SRGB_TRANSFER="");let T=r1[h];T&&(u.defines[T]=""),u.needsUpdate=!0}u.uniforms.tDiffuse.value=L.texture,S.setRenderTarget(m),S.render(d,p),m=null,v=!1},this.isCompositing=function(){return v},this.dispose=function(){r.depthTexture&&r.depthTexture.dispose(),r.dispose(),o.dispose(),l.dispose(),u.dispose()}}var $0=new Ca,cp=new ni(1,1),ev=new Oo,tv=new Qu,av=new Go,U0=[],B0=[],O0=new Float32Array(16),N0=new Float32Array(9),F0=new Float32Array(4);function Rr(t,e,a){let n=t[0];if(n<=0||n>0)return t;let i=e*a,s=U0[i];if(s===void 0&&(s=new Float32Array(i),U0[i]=s),e!==0){n.toArray(s,0);for(let r=1,o=0;r!==e;++r)o+=a,t[r].toArray(s,o)}return s}function Yt(t,e){if(t.length!==e.length)return!1;for(let a=0,n=t.length;a<n;a++)if(t[a]!==e[a])return!1;return!0}function Zt(t,e){for(let a=0,n=e.length;a<n;a++)t[a]=e[a]}function cf(t,e){let a=B0[e];a===void 0&&(a=new Int32Array(e),B0[e]=a);for(let n=0;n!==e;++n)a[n]=t.allocateTextureUnit();return a}function l1(t,e){let a=this.cache;a[0]!==e&&(t.uniform1f(this.addr,e),a[0]=e)}function u1(t,e){let a=this.cache;if(e.x!==void 0)(a[0]!==e.x||a[1]!==e.y)&&(t.uniform2f(this.addr,e.x,e.y),a[0]=e.x,a[1]=e.y);else{if(Yt(a,e))return;t.uniform2fv(this.addr,e),Zt(a,e)}}function c1(t,e){let a=this.cache;if(e.x!==void 0)(a[0]!==e.x||a[1]!==e.y||a[2]!==e.z)&&(t.uniform3f(this.addr,e.x,e.y,e.z),a[0]=e.x,a[1]=e.y,a[2]=e.z);else if(e.r!==void 0)(a[0]!==e.r||a[1]!==e.g||a[2]!==e.b)&&(t.uniform3f(this.addr,e.r,e.g,e.b),a[0]=e.r,a[1]=e.g,a[2]=e.b);else{if(Yt(a,e))return;t.uniform3fv(this.addr,e),Zt(a,e)}}function f1(t,e){let a=this.cache;if(e.x!==void 0)(a[0]!==e.x||a[1]!==e.y||a[2]!==e.z||a[3]!==e.w)&&(t.uniform4f(this.addr,e.x,e.y,e.z,e.w),a[0]=e.x,a[1]=e.y,a[2]=e.z,a[3]=e.w);else{if(Yt(a,e))return;t.uniform4fv(this.addr,e),Zt(a,e)}}function d1(t,e){let a=this.cache,n=e.elements;if(n===void 0){if(Yt(a,e))return;t.uniformMatrix2fv(this.addr,!1,e),Zt(a,e)}else{if(Yt(a,n))return;F0.set(n),t.uniformMatrix2fv(this.addr,!1,F0),Zt(a,n)}}function h1(t,e){let a=this.cache,n=e.elements;if(n===void 0){if(Yt(a,e))return;t.uniformMatrix3fv(this.addr,!1,e),Zt(a,e)}else{if(Yt(a,n))return;N0.set(n),t.uniformMatrix3fv(this.addr,!1,N0),Zt(a,n)}}function p1(t,e){let a=this.cache,n=e.elements;if(n===void 0){if(Yt(a,e))return;t.uniformMatrix4fv(this.addr,!1,e),Zt(a,e)}else{if(Yt(a,n))return;O0.set(n),t.uniformMatrix4fv(this.addr,!1,O0),Zt(a,n)}}function m1(t,e){let a=this.cache;a[0]!==e&&(t.uniform1i(this.addr,e),a[0]=e)}function g1(t,e){let a=this.cache;if(e.x!==void 0)(a[0]!==e.x||a[1]!==e.y)&&(t.uniform2i(this.addr,e.x,e.y),a[0]=e.x,a[1]=e.y);else{if(Yt(a,e))return;t.uniform2iv(this.addr,e),Zt(a,e)}}function x1(t,e){let a=this.cache;if(e.x!==void 0)(a[0]!==e.x||a[1]!==e.y||a[2]!==e.z)&&(t.uniform3i(this.addr,e.x,e.y,e.z),a[0]=e.x,a[1]=e.y,a[2]=e.z);else{if(Yt(a,e))return;t.uniform3iv(this.addr,e),Zt(a,e)}}function v1(t,e){let a=this.cache;if(e.x!==void 0)(a[0]!==e.x||a[1]!==e.y||a[2]!==e.z||a[3]!==e.w)&&(t.uniform4i(this.addr,e.x,e.y,e.z,e.w),a[0]=e.x,a[1]=e.y,a[2]=e.z,a[3]=e.w);else{if(Yt(a,e))return;t.uniform4iv(this.addr,e),Zt(a,e)}}function y1(t,e){let a=this.cache;a[0]!==e&&(t.uniform1ui(this.addr,e),a[0]=e)}function _1(t,e){let a=this.cache;if(e.x!==void 0)(a[0]!==e.x||a[1]!==e.y)&&(t.uniform2ui(this.addr,e.x,e.y),a[0]=e.x,a[1]=e.y);else{if(Yt(a,e))return;t.uniform2uiv(this.addr,e),Zt(a,e)}}function S1(t,e){let a=this.cache;if(e.x!==void 0)(a[0]!==e.x||a[1]!==e.y||a[2]!==e.z)&&(t.uniform3ui(this.addr,e.x,e.y,e.z),a[0]=e.x,a[1]=e.y,a[2]=e.z);else{if(Yt(a,e))return;t.uniform3uiv(this.addr,e),Zt(a,e)}}function M1(t,e){let a=this.cache;if(e.x!==void 0)(a[0]!==e.x||a[1]!==e.y||a[2]!==e.z||a[3]!==e.w)&&(t.uniform4ui(this.addr,e.x,e.y,e.z,e.w),a[0]=e.x,a[1]=e.y,a[2]=e.z,a[3]=e.w);else{if(Yt(a,e))return;t.uniform4uiv(this.addr,e),Zt(a,e)}}function b1(t,e,a){let n=this.cache,i=a.allocateTextureUnit();n[0]!==i&&(t.uniform1i(this.addr,i),n[0]=i);let s;this.type===t.SAMPLER_2D_SHADOW?(cp.compareFunction=a.isReversedDepthBuffer()?af:tf,s=cp):s=$0,a.setTexture2D(e||s,i)}function C1(t,e,a){let n=this.cache,i=a.allocateTextureUnit();n[0]!==i&&(t.uniform1i(this.addr,i),n[0]=i),a.setTexture3D(e||tv,i)}function L1(t,e,a){let n=this.cache,i=a.allocateTextureUnit();n[0]!==i&&(t.uniform1i(this.addr,i),n[0]=i),a.setTextureCube(e||av,i)}function A1(t,e,a){let n=this.cache,i=a.allocateTextureUnit();n[0]!==i&&(t.uniform1i(this.addr,i),n[0]=i),a.setTexture2DArray(e||ev,i)}function T1(t){switch(t){case 5126:return l1;case 35664:return u1;case 35665:return c1;case 35666:return f1;case 35674:return d1;case 35675:return h1;case 35676:return p1;case 5124:case 35670:return m1;case 35667:case 35671:return g1;case 35668:case 35672:return x1;case 35669:case 35673:return v1;case 5125:return y1;case 36294:return _1;case 36295:return S1;case 36296:return M1;case 35678:case 36198:case 36298:case 36306:case 35682:return b1;case 35679:case 36299:case 36307:return C1;case 35680:case 36300:case 36308:case 36293:return L1;case 36289:case 36303:case 36311:case 36292:return A1}}function I1(t,e){t.uniform1fv(this.addr,e)}function E1(t,e){let a=Rr(e,this.size,2);t.uniform2fv(this.addr,a)}function w1(t,e){let a=Rr(e,this.size,3);t.uniform3fv(this.addr,a)}function R1(t,e){let a=Rr(e,this.size,4);t.uniform4fv(this.addr,a)}function D1(t,e){let a=Rr(e,this.size,4);t.uniformMatrix2fv(this.addr,!1,a)}function P1(t,e){let a=Rr(e,this.size,9);t.uniformMatrix3fv(this.addr,!1,a)}function U1(t,e){let a=Rr(e,this.size,16);t.uniformMatrix4fv(this.addr,!1,a)}function B1(t,e){t.uniform1iv(this.addr,e)}function O1(t,e){t.uniform2iv(this.addr,e)}function N1(t,e){t.uniform3iv(this.addr,e)}function F1(t,e){t.uniform4iv(this.addr,e)}function z1(t,e){t.uniform1uiv(this.addr,e)}function k1(t,e){t.uniform2uiv(this.addr,e)}function H1(t,e){t.uniform3uiv(this.addr,e)}function V1(t,e){t.uniform4uiv(this.addr,e)}function G1(t,e,a){let n=this.cache,i=e.length,s=cf(a,i);Yt(n,s)||(t.uniform1iv(this.addr,s),Zt(n,s));let r;this.type===t.SAMPLER_2D_SHADOW?r=cp:r=$0;for(let o=0;o!==i;++o)a.setTexture2D(e[o]||r,s[o])}function q1(t,e,a){let n=this.cache,i=e.length,s=cf(a,i);Yt(n,s)||(t.uniform1iv(this.addr,s),Zt(n,s));for(let r=0;r!==i;++r)a.setTexture3D(e[r]||tv,s[r])}function W1(t,e,a){let n=this.cache,i=e.length,s=cf(a,i);Yt(n,s)||(t.uniform1iv(this.addr,s),Zt(n,s));for(let r=0;r!==i;++r)a.setTextureCube(e[r]||av,s[r])}function X1(t,e,a){let n=this.cache,i=e.length,s=cf(a,i);Yt(n,s)||(t.uniform1iv(this.addr,s),Zt(n,s));for(let r=0;r!==i;++r)a.setTexture2DArray(e[r]||ev,s[r])}function Y1(t){switch(t){case 5126:return I1;case 35664:return E1;case 35665:return w1;case 35666:return R1;case 35674:return D1;case 35675:return P1;case 35676:return U1;case 5124:case 35670:return B1;case 35667:case 35671:return O1;case 35668:case 35672:return N1;case 35669:case 35673:return F1;case 5125:return z1;case 36294:return k1;case 36295:return H1;case 36296:return V1;case 35678:case 36198:case 36298:case 36306:case 35682:return G1;case 35679:case 36299:case 36307:return q1;case 35680:case 36300:case 36308:case 36293:return W1;case 36289:case 36303:case 36311:case 36292:return X1}}var fp=class{constructor(e,a,n){this.id=e,this.addr=n,this.cache=[],this.type=a.type,this.setValue=T1(a.type)}},dp=class{constructor(e,a,n){this.id=e,this.addr=n,this.cache=[],this.type=a.type,this.size=a.size,this.setValue=Y1(a.type)}},hp=class{constructor(e){this.id=e,this.seq=[],this.map={}}setValue(e,a,n){let i=this.seq;for(let s=0,r=i.length;s!==r;++s){let o=i[s];o.setValue(e,a[o.id],n)}}},lp=/(\w+)(\])?(\[|\.)?/g;function z0(t,e){t.seq.push(e),t.map[e.id]=e}function Z1(t,e,a){let n=t.name,i=n.length;for(lp.lastIndex=0;;){let s=lp.exec(n),r=lp.lastIndex,o=s[1],l=s[2]==="]",u=s[3];if(l&&(o=o|0),u===void 0||u==="["&&r+2===i){z0(a,u===void 0?new fp(o,t,e):new dp(o,t,e));break}else{let p=a.map[o];p===void 0&&(p=new hp(o),z0(a,p)),a=p}}}var wr=class{constructor(e,a){this.seq=[],this.map={};let n=e.getProgramParameter(a,e.ACTIVE_UNIFORMS);for(let r=0;r<n;++r){let o=e.getActiveUniform(a,r),l=e.getUniformLocation(a,o.name);Z1(o,l,this)}let i=[],s=[];for(let r of this.seq)r.type===e.SAMPLER_2D_SHADOW||r.type===e.SAMPLER_CUBE_SHADOW||r.type===e.SAMPLER_2D_ARRAY_SHADOW?i.push(r):s.push(r);i.length>0&&(this.seq=i.concat(s))}setValue(e,a,n,i){let s=this.map[a];s!==void 0&&s.setValue(e,n,i)}setOptional(e,a,n){let i=a[n];i!==void 0&&this.setValue(e,n,i)}static upload(e,a,n,i){for(let s=0,r=a.length;s!==r;++s){let o=a[s],l=n[o.id];l.needsUpdate!==!1&&o.setValue(e,l.value,i)}}static seqWithValue(e,a){let n=[];for(let i=0,s=e.length;i!==s;++i){let r=e[i];r.id in a&&n.push(r)}return n}};function k0(t,e,a){let n=t.createShader(e);return t.shaderSource(n,a),t.compileShader(n),n}var K1=37297,J1=0;function Q1(t,e){let a=t.split(`
`),n=[],i=Math.max(e-6,0),s=Math.min(e+6,a.length);for(let r=i;r<s;r++){let o=r+1;n.push(`${o===e?">":" "} ${o}: ${a[r]}`)}return n.join(`
`)}var H0=new De;function j1(t){Ge._getMatrix(H0,Ge.workingColorSpace,t);let e=`mat3( ${H0.elements.map(a=>a.toFixed(4))} )`;switch(Ge.getTransfer(t)){case Po:return[e,"LinearTransferOETF"];case at:return[e,"sRGBTransferOETF"];default:return Ae("WebGLProgram: Unsupported color space: ",t),[e,"LinearTransferOETF"]}}function V0(t,e,a){let n=t.getShaderParameter(e,t.COMPILE_STATUS),s=(t.getShaderInfoLog(e)||"").trim();if(n&&s==="")return"";let r=/ERROR: 0:(\d+)/.exec(s);if(r){let o=parseInt(r[1]);return a.toUpperCase()+`

`+s+`

`+Q1(t.getShaderSource(e),o)}else return s}function $1(t,e){let a=j1(e);return[`vec4 ${t}( vec4 value ) {`,`	return ${a[1]}( vec4( value.rgb * ${a[0]}, value.a ) );`,"}"].join(`
`)}var eT={[Oh]:"Linear",[Nh]:"Reinhard",[Fh]:"Cineon",[zh]:"ACESFilmic",[Hh]:"AgX",[Vh]:"Neutral",[kh]:"Custom"};function tT(t,e){let a=eT[e];return a===void 0?(Ae("WebGLProgram: Unsupported toneMapping:",e),"vec3 "+t+"( vec3 color ) { return LinearToneMapping( color ); }"):"vec3 "+t+"( vec3 color ) { return "+a+"ToneMapping( color ); }"}var sf=new F;function aT(){Ge.getLuminanceCoefficients(sf);let t=sf.x.toFixed(4),e=sf.y.toFixed(4),a=sf.z.toFixed(4);return["float luminance( const in vec3 rgb ) {",`	const vec3 weights = vec3( ${t}, ${e}, ${a} );`,"	return dot( weights, rgb );","}"].join(`
`)}function nT(t){return[t.extensionClipCullDistance?"#extension GL_ANGLE_clip_cull_distance : require":"",t.extensionMultiDraw?"#extension GL_ANGLE_multi_draw : require":""].filter(ol).join(`
`)}function iT(t){let e=[];for(let a in t){let n=t[a];n!==!1&&e.push("#define "+a+" "+n)}return e.join(`
`)}function sT(t,e){let a={},n=t.getProgramParameter(e,t.ACTIVE_ATTRIBUTES);for(let i=0;i<n;i++){let s=t.getActiveAttrib(e,i),r=s.name,o=1;s.type===t.FLOAT_MAT2&&(o=2),s.type===t.FLOAT_MAT3&&(o=3),s.type===t.FLOAT_MAT4&&(o=4),a[r]={type:s.type,location:t.getAttribLocation(e,r),locationSize:o}}return a}function ol(t){return t!==""}function G0(t,e){let a=e.numSpotLightShadows+e.numSpotLightMaps-e.numSpotLightShadowsWithMaps;return t.replace(/NUM_DIR_LIGHTS/g,e.numDirLights).replace(/NUM_SPOT_LIGHTS/g,e.numSpotLights).replace(/NUM_SPOT_LIGHT_MAPS/g,e.numSpotLightMaps).replace(/NUM_SPOT_LIGHT_COORDS/g,a).replace(/NUM_RECT_AREA_LIGHTS/g,e.numRectAreaLights).replace(/NUM_POINT_LIGHTS/g,e.numPointLights).replace(/NUM_HEMI_LIGHTS/g,e.numHemiLights).replace(/NUM_DIR_LIGHT_SHADOWS/g,e.numDirLightShadows).replace(/NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS/g,e.numSpotLightShadowsWithMaps).replace(/NUM_SPOT_LIGHT_SHADOWS/g,e.numSpotLightShadows).replace(/NUM_POINT_LIGHT_SHADOWS/g,e.numPointLightShadows)}function q0(t,e){return t.replace(/NUM_CLIPPING_PLANES/g,e.numClippingPlanes).replace(/UNION_CLIPPING_PLANES/g,e.numClippingPlanes-e.numClipIntersection)}var rT=/^[ \t]*#include +<([\w\d./]+)>/gm;function pp(t){return t.replace(rT,lT)}var oT=new Map;function lT(t,e){let a=Fe[e];if(a===void 0){let n=oT.get(e);if(n!==void 0)a=Fe[n],Ae('WebGLRenderer: Shader chunk "%s" has been deprecated. Use "%s" instead.',e,n);else throw new Error("THREE.WebGLProgram: Can not resolve #include <"+e+">")}return pp(a)}var uT=/#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;function W0(t){return t.replace(uT,cT)}function cT(t,e,a,n){let i="";for(let s=parseInt(e);s<parseInt(a);s++)i+=n.replace(/\[\s*i\s*\]/g,"[ "+s+" ]").replace(/UNROLLED_LOOP_INDEX/g,s);return i}function X0(t){let e=`precision ${t.precision} float;
	precision ${t.precision} int;
	precision ${t.precision} sampler2D;
	precision ${t.precision} samplerCube;
	precision ${t.precision} sampler3D;
	precision ${t.precision} sampler2DArray;
	precision ${t.precision} sampler2DShadow;
	precision ${t.precision} samplerCubeShadow;
	precision ${t.precision} sampler2DArrayShadow;
	precision ${t.precision} isampler2D;
	precision ${t.precision} isampler3D;
	precision ${t.precision} isamplerCube;
	precision ${t.precision} isampler2DArray;
	precision ${t.precision} usampler2D;
	precision ${t.precision} usampler3D;
	precision ${t.precision} usamplerCube;
	precision ${t.precision} usampler2DArray;
	`;return t.precision==="highp"?e+=`
#define HIGH_PRECISION`:t.precision==="mediump"?e+=`
#define MEDIUM_PRECISION`:t.precision==="lowp"&&(e+=`
#define LOW_PRECISION`),e}var fT={[Ko]:"SHADOWMAP_TYPE_PCF",[Ar]:"SHADOWMAP_TYPE_VSM"};function dT(t){return fT[t.shadowMapType]||"SHADOWMAP_TYPE_BASIC"}var hT={[Gi]:"ENVMAP_TYPE_CUBE",[Us]:"ENVMAP_TYPE_CUBE",[Jo]:"ENVMAP_TYPE_CUBE_UV"};function pT(t){return t.envMap===!1?"ENVMAP_TYPE_CUBE":hT[t.envMapMode]||"ENVMAP_TYPE_CUBE"}var mT={[Us]:"ENVMAP_MODE_REFRACTION"};function gT(t){return t.envMap===!1?"ENVMAP_MODE_REFLECTION":mT[t.envMapMode]||"ENVMAP_MODE_REFLECTION"}var xT={[Bh]:"ENVMAP_BLENDING_MULTIPLY",[f0]:"ENVMAP_BLENDING_MIX",[d0]:"ENVMAP_BLENDING_ADD"};function vT(t){return t.envMap===!1?"ENVMAP_BLENDING_NONE":xT[t.combine]||"ENVMAP_BLENDING_NONE"}function yT(t){let e=t.envMapCubeUVHeight;if(e===null)return null;let a=Math.log2(e)-2,n=1/e;return{texelWidth:1/(3*Math.max(Math.pow(2,a),112)),texelHeight:n,maxMip:a}}function _T(t,e,a,n){let i=t.getContext(),s=a.defines,r=a.vertexShader,o=a.fragmentShader,l=dT(a),u=pT(a),d=gT(a),p=vT(a),c=yT(a),h=nT(a),v=iT(s),b=i.createProgram(),m,f,x=a.glslVersion?"#version "+a.glslVersion+`
`:"";a.isRawShaderMaterial?(m=["#define SHADER_TYPE "+a.shaderType,"#define SHADER_NAME "+a.shaderName,v].filter(ol).join(`
`),m.length>0&&(m+=`
`),f=["#define SHADER_TYPE "+a.shaderType,"#define SHADER_NAME "+a.shaderName,v].filter(ol).join(`
`),f.length>0&&(f+=`
`)):(m=[X0(a),"#define SHADER_TYPE "+a.shaderType,"#define SHADER_NAME "+a.shaderName,v,a.extensionClipCullDistance?"#define USE_CLIP_DISTANCE":"",a.batching?"#define USE_BATCHING":"",a.batchingColor?"#define USE_BATCHING_COLOR":"",a.instancing?"#define USE_INSTANCING":"",a.instancingColor?"#define USE_INSTANCING_COLOR":"",a.instancingMorph?"#define USE_INSTANCING_MORPH":"",a.useFog&&a.fog?"#define USE_FOG":"",a.useFog&&a.fogExp2?"#define FOG_EXP2":"",a.map?"#define USE_MAP":"",a.envMap?"#define USE_ENVMAP":"",a.envMap?"#define "+d:"",a.lightMap?"#define USE_LIGHTMAP":"",a.aoMap?"#define USE_AOMAP":"",a.bumpMap?"#define USE_BUMPMAP":"",a.normalMap?"#define USE_NORMALMAP":"",a.normalMapObjectSpace?"#define USE_NORMALMAP_OBJECTSPACE":"",a.normalMapTangentSpace?"#define USE_NORMALMAP_TANGENTSPACE":"",a.displacementMap?"#define USE_DISPLACEMENTMAP":"",a.emissiveMap?"#define USE_EMISSIVEMAP":"",a.anisotropy?"#define USE_ANISOTROPY":"",a.anisotropyMap?"#define USE_ANISOTROPYMAP":"",a.clearcoatMap?"#define USE_CLEARCOATMAP":"",a.clearcoatRoughnessMap?"#define USE_CLEARCOAT_ROUGHNESSMAP":"",a.clearcoatNormalMap?"#define USE_CLEARCOAT_NORMALMAP":"",a.iridescenceMap?"#define USE_IRIDESCENCEMAP":"",a.iridescenceThicknessMap?"#define USE_IRIDESCENCE_THICKNESSMAP":"",a.specularMap?"#define USE_SPECULARMAP":"",a.specularColorMap?"#define USE_SPECULAR_COLORMAP":"",a.specularIntensityMap?"#define USE_SPECULAR_INTENSITYMAP":"",a.roughnessMap?"#define USE_ROUGHNESSMAP":"",a.metalnessMap?"#define USE_METALNESSMAP":"",a.alphaMap?"#define USE_ALPHAMAP":"",a.alphaHash?"#define USE_ALPHAHASH":"",a.transmission?"#define USE_TRANSMISSION":"",a.transmissionMap?"#define USE_TRANSMISSIONMAP":"",a.thicknessMap?"#define USE_THICKNESSMAP":"",a.sheenColorMap?"#define USE_SHEEN_COLORMAP":"",a.sheenRoughnessMap?"#define USE_SHEEN_ROUGHNESSMAP":"",a.mapUv?"#define MAP_UV "+a.mapUv:"",a.alphaMapUv?"#define ALPHAMAP_UV "+a.alphaMapUv:"",a.lightMapUv?"#define LIGHTMAP_UV "+a.lightMapUv:"",a.aoMapUv?"#define AOMAP_UV "+a.aoMapUv:"",a.emissiveMapUv?"#define EMISSIVEMAP_UV "+a.emissiveMapUv:"",a.bumpMapUv?"#define BUMPMAP_UV "+a.bumpMapUv:"",a.normalMapUv?"#define NORMALMAP_UV "+a.normalMapUv:"",a.displacementMapUv?"#define DISPLACEMENTMAP_UV "+a.displacementMapUv:"",a.metalnessMapUv?"#define METALNESSMAP_UV "+a.metalnessMapUv:"",a.roughnessMapUv?"#define ROUGHNESSMAP_UV "+a.roughnessMapUv:"",a.anisotropyMapUv?"#define ANISOTROPYMAP_UV "+a.anisotropyMapUv:"",a.clearcoatMapUv?"#define CLEARCOATMAP_UV "+a.clearcoatMapUv:"",a.clearcoatNormalMapUv?"#define CLEARCOAT_NORMALMAP_UV "+a.clearcoatNormalMapUv:"",a.clearcoatRoughnessMapUv?"#define CLEARCOAT_ROUGHNESSMAP_UV "+a.clearcoatRoughnessMapUv:"",a.iridescenceMapUv?"#define IRIDESCENCEMAP_UV "+a.iridescenceMapUv:"",a.iridescenceThicknessMapUv?"#define IRIDESCENCE_THICKNESSMAP_UV "+a.iridescenceThicknessMapUv:"",a.sheenColorMapUv?"#define SHEEN_COLORMAP_UV "+a.sheenColorMapUv:"",a.sheenRoughnessMapUv?"#define SHEEN_ROUGHNESSMAP_UV "+a.sheenRoughnessMapUv:"",a.specularMapUv?"#define SPECULARMAP_UV "+a.specularMapUv:"",a.specularColorMapUv?"#define SPECULAR_COLORMAP_UV "+a.specularColorMapUv:"",a.specularIntensityMapUv?"#define SPECULAR_INTENSITYMAP_UV "+a.specularIntensityMapUv:"",a.transmissionMapUv?"#define TRANSMISSIONMAP_UV "+a.transmissionMapUv:"",a.thicknessMapUv?"#define THICKNESSMAP_UV "+a.thicknessMapUv:"",a.vertexTangents&&a.flatShading===!1?"#define USE_TANGENT":"",a.vertexNormals?"#define HAS_NORMAL":"",a.vertexColors?"#define USE_COLOR":"",a.vertexAlphas?"#define USE_COLOR_ALPHA":"",a.vertexUv1s?"#define USE_UV1":"",a.vertexUv2s?"#define USE_UV2":"",a.vertexUv3s?"#define USE_UV3":"",a.pointsUvs?"#define USE_POINTS_UV":"",a.flatShading?"#define FLAT_SHADED":"",a.skinning?"#define USE_SKINNING":"",a.morphTargets?"#define USE_MORPHTARGETS":"",a.morphNormals&&a.flatShading===!1?"#define USE_MORPHNORMALS":"",a.morphColors?"#define USE_MORPHCOLORS":"",a.morphTargetsCount>0?"#define MORPHTARGETS_TEXTURE_STRIDE "+a.morphTextureStride:"",a.morphTargetsCount>0?"#define MORPHTARGETS_COUNT "+a.morphTargetsCount:"",a.doubleSided?"#define DOUBLE_SIDED":"",a.flipSided?"#define FLIP_SIDED":"",a.shadowMapEnabled?"#define USE_SHADOWMAP":"",a.shadowMapEnabled?"#define "+l:"",a.sizeAttenuation?"#define USE_SIZEATTENUATION":"",a.numLightProbes>0?"#define USE_LIGHT_PROBES":"",a.logarithmicDepthBuffer?"#define USE_LOGARITHMIC_DEPTH_BUFFER":"",a.reversedDepthBuffer?"#define USE_REVERSED_DEPTH_BUFFER":"","uniform mat4 modelMatrix;","uniform mat4 modelViewMatrix;","uniform mat4 projectionMatrix;","uniform mat4 viewMatrix;","uniform mat3 normalMatrix;","uniform vec3 cameraPosition;","uniform bool isOrthographic;","#ifdef USE_INSTANCING","	attribute mat4 instanceMatrix;","#endif","#ifdef USE_INSTANCING_COLOR","	attribute vec3 instanceColor;","#endif","#ifdef USE_INSTANCING_MORPH","	uniform sampler2D morphTexture;","#endif","attribute vec3 position;","attribute vec3 normal;","attribute vec2 uv;","#ifdef USE_UV1","	attribute vec2 uv1;","#endif","#ifdef USE_UV2","	attribute vec2 uv2;","#endif","#ifdef USE_UV3","	attribute vec2 uv3;","#endif","#ifdef USE_TANGENT","	attribute vec4 tangent;","#endif","#if defined( USE_COLOR_ALPHA )","	attribute vec4 color;","#elif defined( USE_COLOR )","	attribute vec3 color;","#endif","#ifdef USE_SKINNING","	attribute vec4 skinIndex;","	attribute vec4 skinWeight;","#endif",`
`].filter(ol).join(`
`),f=[X0(a),"#define SHADER_TYPE "+a.shaderType,"#define SHADER_NAME "+a.shaderName,v,a.useFog&&a.fog?"#define USE_FOG":"",a.useFog&&a.fogExp2?"#define FOG_EXP2":"",a.alphaToCoverage?"#define ALPHA_TO_COVERAGE":"",a.map?"#define USE_MAP":"",a.matcap?"#define USE_MATCAP":"",a.envMap?"#define USE_ENVMAP":"",a.envMap?"#define "+u:"",a.envMap?"#define "+d:"",a.envMap?"#define "+p:"",c?"#define CUBEUV_TEXEL_WIDTH "+c.texelWidth:"",c?"#define CUBEUV_TEXEL_HEIGHT "+c.texelHeight:"",c?"#define CUBEUV_MAX_MIP "+c.maxMip+".0":"",a.lightMap?"#define USE_LIGHTMAP":"",a.aoMap?"#define USE_AOMAP":"",a.bumpMap?"#define USE_BUMPMAP":"",a.normalMap?"#define USE_NORMALMAP":"",a.normalMapObjectSpace?"#define USE_NORMALMAP_OBJECTSPACE":"",a.normalMapTangentSpace?"#define USE_NORMALMAP_TANGENTSPACE":"",a.packedNormalMap?"#define USE_PACKED_NORMALMAP":"",a.emissiveMap?"#define USE_EMISSIVEMAP":"",a.anisotropy?"#define USE_ANISOTROPY":"",a.anisotropyMap?"#define USE_ANISOTROPYMAP":"",a.clearcoat?"#define USE_CLEARCOAT":"",a.clearcoatMap?"#define USE_CLEARCOATMAP":"",a.clearcoatRoughnessMap?"#define USE_CLEARCOAT_ROUGHNESSMAP":"",a.clearcoatNormalMap?"#define USE_CLEARCOAT_NORMALMAP":"",a.dispersion?"#define USE_DISPERSION":"",a.iridescence?"#define USE_IRIDESCENCE":"",a.iridescenceMap?"#define USE_IRIDESCENCEMAP":"",a.iridescenceThicknessMap?"#define USE_IRIDESCENCE_THICKNESSMAP":"",a.specularMap?"#define USE_SPECULARMAP":"",a.specularColorMap?"#define USE_SPECULAR_COLORMAP":"",a.specularIntensityMap?"#define USE_SPECULAR_INTENSITYMAP":"",a.roughnessMap?"#define USE_ROUGHNESSMAP":"",a.metalnessMap?"#define USE_METALNESSMAP":"",a.alphaMap?"#define USE_ALPHAMAP":"",a.alphaTest?"#define USE_ALPHATEST":"",a.alphaHash?"#define USE_ALPHAHASH":"",a.sheen?"#define USE_SHEEN":"",a.sheenColorMap?"#define USE_SHEEN_COLORMAP":"",a.sheenRoughnessMap?"#define USE_SHEEN_ROUGHNESSMAP":"",a.transmission?"#define USE_TRANSMISSION":"",a.transmissionMap?"#define USE_TRANSMISSIONMAP":"",a.thicknessMap?"#define USE_THICKNESSMAP":"",a.vertexTangents&&a.flatShading===!1?"#define USE_TANGENT":"",a.vertexColors||a.instancingColor?"#define USE_COLOR":"",a.vertexAlphas||a.batchingColor?"#define USE_COLOR_ALPHA":"",a.vertexUv1s?"#define USE_UV1":"",a.vertexUv2s?"#define USE_UV2":"",a.vertexUv3s?"#define USE_UV3":"",a.pointsUvs?"#define USE_POINTS_UV":"",a.gradientMap?"#define USE_GRADIENTMAP":"",a.flatShading?"#define FLAT_SHADED":"",a.doubleSided?"#define DOUBLE_SIDED":"",a.flipSided?"#define FLIP_SIDED":"",a.shadowMapEnabled?"#define USE_SHADOWMAP":"",a.shadowMapEnabled?"#define "+l:"",a.premultipliedAlpha?"#define PREMULTIPLIED_ALPHA":"",a.numLightProbes>0?"#define USE_LIGHT_PROBES":"",a.numLightProbeGrids>0?"#define USE_LIGHT_PROBES_GRID":"",a.decodeVideoTexture?"#define DECODE_VIDEO_TEXTURE":"",a.decodeVideoTextureEmissive?"#define DECODE_VIDEO_TEXTURE_EMISSIVE":"",a.logarithmicDepthBuffer?"#define USE_LOGARITHMIC_DEPTH_BUFFER":"",a.reversedDepthBuffer?"#define USE_REVERSED_DEPTH_BUFFER":"","uniform mat4 viewMatrix;","uniform vec3 cameraPosition;","uniform bool isOrthographic;",a.toneMapping!==vn?"#define TONE_MAPPING":"",a.toneMapping!==vn?Fe.tonemapping_pars_fragment:"",a.toneMapping!==vn?tT("toneMapping",a.toneMapping):"",a.dithering?"#define DITHERING":"",a.opaque?"#define OPAQUE":"",Fe.colorspace_pars_fragment,$1("linearToOutputTexel",a.outputColorSpace),aT(),a.useDepthPacking?"#define DEPTH_PACKING "+a.depthPacking:"",`
`].filter(ol).join(`
`)),r=pp(r),r=G0(r,a),r=q0(r,a),o=pp(o),o=G0(o,a),o=q0(o,a),r=W0(r),o=W0(o),a.isRawShaderMaterial!==!0&&(x=`#version 300 es
`,m=[h,"#define attribute in","#define varying out","#define texture2D texture"].join(`
`)+`
`+m,f=["#define varying in",a.glslVersion===jh?"":"layout(location = 0) out highp vec4 pc_fragColor;",a.glslVersion===jh?"":"#define gl_FragColor pc_fragColor","#define gl_FragDepthEXT gl_FragDepth","#define texture2D texture","#define textureCube texture","#define texture2DProj textureProj","#define texture2DLodEXT textureLod","#define texture2DProjLodEXT textureProjLod","#define textureCubeLodEXT textureLod","#define texture2DGradEXT textureGrad","#define texture2DProjGradEXT textureProjGrad","#define textureCubeGradEXT textureGrad"].join(`
`)+`
`+f);let S=x+m+r,_=x+f+o,L=k0(i,i.VERTEX_SHADER,S),C=k0(i,i.FRAGMENT_SHADER,_);i.attachShader(b,L),i.attachShader(b,C),a.index0AttributeName!==void 0?i.bindAttribLocation(b,0,a.index0AttributeName):a.hasPositionAttribute===!0&&i.bindAttribLocation(b,0,"position"),i.linkProgram(b);function T(w){if(t.debug.checkShaderErrors){let B=i.getProgramInfoLog(b)||"",X=i.getShaderInfoLog(L)||"",K=i.getShaderInfoLog(C)||"",z=B.trim(),W=X.trim(),V=K.trim(),j=!0,ee=!0;if(i.getProgramParameter(b,i.LINK_STATUS)===!1)if(j=!1,typeof t.debug.onShaderError=="function")t.debug.onShaderError(i,b,L,C);else{let fe=V0(i,L,"vertex"),me=V0(i,C,"fragment");Ee("WebGLProgram: Shader Error "+i.getError()+" - VALIDATE_STATUS "+i.getProgramParameter(b,i.VALIDATE_STATUS)+`

Material Name: `+w.name+`
Material Type: `+w.type+`

Program Info Log: `+z+`
`+fe+`
`+me)}else z!==""?Ae("WebGLProgram: Program Info Log:",z):(W===""||V==="")&&(ee=!1);ee&&(w.diagnostics={runnable:j,programLog:z,vertexShader:{log:W,prefix:m},fragmentShader:{log:V,prefix:f}})}i.deleteShader(L),i.deleteShader(C),y=new wr(i,b),A=sT(i,b)}let y;this.getUniforms=function(){return y===void 0&&T(this),y};let A;this.getAttributes=function(){return A===void 0&&T(this),A};let E=a.rendererExtensionParallelShaderCompile===!1;return this.isReady=function(){return E===!1&&(E=i.getProgramParameter(b,K1)),E},this.destroy=function(){n.releaseStatesOfProgram(this),i.deleteProgram(b),this.program=void 0},this.type=a.shaderType,this.name=a.shaderName,this.id=J1++,this.cacheKey=e,this.usedTimes=1,this.program=b,this.vertexShader=L,this.fragmentShader=C,this}var ST=0,mp=class{constructor(){this.shaderCache=new Map,this.materialCache=new Map}update(e,a,n){let i=this._getShaderCacheForMaterial(e);return i.has(a)===!1&&(i.add(a),a.usedTimes++),i.has(n)===!1&&(i.add(n),n.usedTimes++),this}remove(e){let a=this.materialCache.get(e);for(let n of a)n.usedTimes--,n.usedTimes===0&&this.shaderCache.delete(n.code);return this.materialCache.delete(e),this}getVertexShaderStage(e){return this._getShaderStage(e.vertexShader)}getFragmentShaderStage(e){return this._getShaderStage(e.fragmentShader)}dispose(){this.shaderCache.clear(),this.materialCache.clear()}_getShaderCacheForMaterial(e){let a=this.materialCache,n=a.get(e);return n===void 0&&(n=new Set,a.set(e,n)),n}_getShaderStage(e){let a=this.shaderCache,n=a.get(e);return n===void 0&&(n=new gp(e),a.set(e,n)),n}},gp=class{constructor(e){this.id=ST++,this.code=e,this.usedTimes=0}};function MT(t){return t===Xi||t===al||t===nl}function bT(t,e,a,n,i,s){let r=new No,o=new mp,l=new Set,u=[],d=new Map,p=n.logarithmicDepthBuffer,c=n.precision,h={MeshDepthMaterial:"depth",MeshDistanceMaterial:"distance",MeshNormalMaterial:"normal",MeshBasicMaterial:"basic",MeshLambertMaterial:"lambert",MeshPhongMaterial:"phong",MeshToonMaterial:"toon",MeshStandardMaterial:"physical",MeshPhysicalMaterial:"physical",MeshMatcapMaterial:"matcap",LineBasicMaterial:"basic",LineDashedMaterial:"dashed",PointsMaterial:"points",ShadowMaterial:"shadow",SpriteMaterial:"sprite"};function v(y){return l.add(y),y===0?"uv":`uv${y}`}function b(y,A,E,w,B,X){let K=w.fog,z=B.geometry,W=y.isMeshStandardMaterial||y.isMeshLambertMaterial||y.isMeshPhongMaterial?w.environment:null,V=y.isMeshStandardMaterial||y.isMeshLambertMaterial&&!y.envMap||y.isMeshPhongMaterial&&!y.envMap,j=e.get(y.envMap||W,V),ee=j&&j.mapping===Jo?j.image.height:null,fe=h[y.type];y.precision!==null&&(c=n.getMaxPrecision(y.precision),c!==y.precision&&Ae("WebGLProgram.getParameters:",y.precision,"not supported, using",c,"instead."));let me=z.morphAttributes.position||z.morphAttributes.normal||z.morphAttributes.color,ve=me!==void 0?me.length:0,Qe=0;z.morphAttributes.position!==void 0&&(Qe=1),z.morphAttributes.normal!==void 0&&(Qe=2),z.morphAttributes.color!==void 0&&(Qe=3);let Tt,je,J,ie;if(fe){let ye=kn[fe];Tt=ye.vertexShader,je=ye.fragmentShader}else{Tt=y.vertexShader,je=y.fragmentShader;let ye=o.getVertexShaderStage(y),Et=o.getFragmentShaderStage(y);o.update(y,ye,Et),J=ye.id,ie=Et.id}let te=t.getRenderTarget(),Re=t.state.buffers.depth.getReversed(),Ue=B.isInstancedMesh===!0,Te=B.isBatchedMesh===!0,Pt=!!y.map,Ve=!!y.matcap,ut=!!j,$e=!!y.aoMap,Ze=!!y.lightMap,zt=!!y.bumpMap&&y.wireframe===!1,Xt=!!y.normalMap,Qt=!!y.displacementMap,na=!!y.emissiveMap,It=!!y.metalnessMap,kt=!!y.roughnessMap,D=y.anisotropy>0,Ma=y.clearcoat>0,nt=y.dispersion>0,I=y.iridescence>0,g=y.sheen>0,U=y.transmission>0,k=D&&!!y.anisotropyMap,G=Ma&&!!y.clearcoatMap,ae=Ma&&!!y.clearcoatNormalMap,se=Ma&&!!y.clearcoatRoughnessMap,q=I&&!!y.iridescenceMap,Z=I&&!!y.iridescenceThicknessMap,re=g&&!!y.sheenColorMap,Me=g&&!!y.sheenRoughnessMap,ue=!!y.specularMap,oe=!!y.specularColorMap,Le=!!y.specularIntensityMap,Ie=U&&!!y.transmissionMap,Be=U&&!!y.thicknessMap,R=!!y.gradientMap,ne=!!y.alphaMap,Y=y.alphaTest>0,le=!!y.alphaHash,pe=!!y.extensions,$=vn;y.toneMapped&&(te===null||te.isXRRenderTarget===!0)&&($=t.toneMapping);let Se={shaderID:fe,shaderType:y.type,shaderName:y.name,vertexShader:Tt,fragmentShader:je,defines:y.defines,customVertexShaderID:J,customFragmentShaderID:ie,isRawShaderMaterial:y.isRawShaderMaterial===!0,glslVersion:y.glslVersion,precision:c,batching:Te,batchingColor:Te&&B._colorsTexture!==null,instancing:Ue,instancingColor:Ue&&B.instanceColor!==null,instancingMorph:Ue&&B.morphTexture!==null,outputColorSpace:te===null?t.outputColorSpace:te.isXRRenderTarget===!0?te.texture.colorSpace:Ge.workingColorSpace,alphaToCoverage:!!y.alphaToCoverage,map:Pt,matcap:Ve,envMap:ut,envMapMode:ut&&j.mapping,envMapCubeUVHeight:ee,aoMap:$e,lightMap:Ze,bumpMap:zt,normalMap:Xt,displacementMap:Qt,emissiveMap:na,normalMapObjectSpace:Xt&&y.normalMapType===m0,normalMapTangentSpace:Xt&&y.normalMapType===Qh,packedNormalMap:Xt&&y.normalMapType===Qh&&MT(y.normalMap.format),metalnessMap:It,roughnessMap:kt,anisotropy:D,anisotropyMap:k,clearcoat:Ma,clearcoatMap:G,clearcoatNormalMap:ae,clearcoatRoughnessMap:se,dispersion:nt,iridescence:I,iridescenceMap:q,iridescenceThicknessMap:Z,sheen:g,sheenColorMap:re,sheenRoughnessMap:Me,specularMap:ue,specularColorMap:oe,specularIntensityMap:Le,transmission:U,transmissionMap:Ie,thicknessMap:Be,gradientMap:R,opaque:y.transparent===!1&&y.blending===ws&&y.alphaToCoverage===!1,alphaMap:ne,alphaTest:Y,alphaHash:le,combine:y.combine,mapUv:Pt&&v(y.map.channel),aoMapUv:$e&&v(y.aoMap.channel),lightMapUv:Ze&&v(y.lightMap.channel),bumpMapUv:zt&&v(y.bumpMap.channel),normalMapUv:Xt&&v(y.normalMap.channel),displacementMapUv:Qt&&v(y.displacementMap.channel),emissiveMapUv:na&&v(y.emissiveMap.channel),metalnessMapUv:It&&v(y.metalnessMap.channel),roughnessMapUv:kt&&v(y.roughnessMap.channel),anisotropyMapUv:k&&v(y.anisotropyMap.channel),clearcoatMapUv:G&&v(y.clearcoatMap.channel),clearcoatNormalMapUv:ae&&v(y.clearcoatNormalMap.channel),clearcoatRoughnessMapUv:se&&v(y.clearcoatRoughnessMap.channel),iridescenceMapUv:q&&v(y.iridescenceMap.channel),iridescenceThicknessMapUv:Z&&v(y.iridescenceThicknessMap.channel),sheenColorMapUv:re&&v(y.sheenColorMap.channel),sheenRoughnessMapUv:Me&&v(y.sheenRoughnessMap.channel),specularMapUv:ue&&v(y.specularMap.channel),specularColorMapUv:oe&&v(y.specularColorMap.channel),specularIntensityMapUv:Le&&v(y.specularIntensityMap.channel),transmissionMapUv:Ie&&v(y.transmissionMap.channel),thicknessMapUv:Be&&v(y.thicknessMap.channel),alphaMapUv:ne&&v(y.alphaMap.channel),vertexTangents:!!z.attributes.tangent&&(Xt||D),vertexNormals:!!z.attributes.normal,vertexColors:y.vertexColors,vertexAlphas:y.vertexColors===!0&&!!z.attributes.color&&z.attributes.color.itemSize===4,pointsUvs:B.isPoints===!0&&!!z.attributes.uv&&(Pt||ne),fog:!!K,useFog:y.fog===!0,fogExp2:!!K&&K.isFogExp2,flatShading:y.wireframe===!1&&(y.flatShading===!0||z.attributes.normal===void 0&&Xt===!1&&(y.isMeshLambertMaterial||y.isMeshPhongMaterial||y.isMeshStandardMaterial||y.isMeshPhysicalMaterial)),sizeAttenuation:y.sizeAttenuation===!0,logarithmicDepthBuffer:p,reversedDepthBuffer:Re,skinning:B.isSkinnedMesh===!0,hasPositionAttribute:z.attributes.position!==void 0,morphTargets:z.morphAttributes.position!==void 0,morphNormals:z.morphAttributes.normal!==void 0,morphColors:z.morphAttributes.color!==void 0,morphTargetsCount:ve,morphTextureStride:Qe,numDirLights:A.directional.length,numPointLights:A.point.length,numSpotLights:A.spot.length,numSpotLightMaps:A.spotLightMap.length,numRectAreaLights:A.rectArea.length,numHemiLights:A.hemi.length,numDirLightShadows:A.directionalShadowMap.length,numPointLightShadows:A.pointShadowMap.length,numSpotLightShadows:A.spotShadowMap.length,numSpotLightShadowsWithMaps:A.numSpotLightShadowsWithMaps,numLightProbes:A.numLightProbes,numLightProbeGrids:X.length,numClippingPlanes:s.numPlanes,numClipIntersection:s.numIntersection,dithering:y.dithering,shadowMapEnabled:t.shadowMap.enabled&&E.length>0,shadowMapType:t.shadowMap.type,toneMapping:$,decodeVideoTexture:Pt&&y.map.isVideoTexture===!0&&Ge.getTransfer(y.map.colorSpace)===at,decodeVideoTextureEmissive:na&&y.emissiveMap.isVideoTexture===!0&&Ge.getTransfer(y.emissiveMap.colorSpace)===at,premultipliedAlpha:y.premultipliedAlpha,doubleSided:y.side===On,flipSided:y.side===va,useDepthPacking:y.depthPacking>=0,depthPacking:y.depthPacking||0,index0AttributeName:y.index0AttributeName,extensionClipCullDistance:pe&&y.extensions.clipCullDistance===!0&&a.has("WEBGL_clip_cull_distance"),extensionMultiDraw:(pe&&y.extensions.multiDraw===!0||Te)&&a.has("WEBGL_multi_draw"),rendererExtensionParallelShaderCompile:a.has("KHR_parallel_shader_compile"),customProgramCacheKey:y.customProgramCacheKey()};return Se.vertexUv1s=l.has(1),Se.vertexUv2s=l.has(2),Se.vertexUv3s=l.has(3),l.clear(),Se}function m(y){let A=[];if(y.shaderID?A.push(y.shaderID):(A.push(y.customVertexShaderID),A.push(y.customFragmentShaderID)),y.defines!==void 0)for(let E in y.defines)A.push(E),A.push(y.defines[E]);return y.isRawShaderMaterial===!1&&(f(A,y),x(A,y),A.push(t.outputColorSpace)),A.push(y.customProgramCacheKey),A.join()}function f(y,A){y.push(A.precision),y.push(A.outputColorSpace),y.push(A.envMapMode),y.push(A.envMapCubeUVHeight),y.push(A.mapUv),y.push(A.alphaMapUv),y.push(A.lightMapUv),y.push(A.aoMapUv),y.push(A.bumpMapUv),y.push(A.normalMapUv),y.push(A.displacementMapUv),y.push(A.emissiveMapUv),y.push(A.metalnessMapUv),y.push(A.roughnessMapUv),y.push(A.anisotropyMapUv),y.push(A.clearcoatMapUv),y.push(A.clearcoatNormalMapUv),y.push(A.clearcoatRoughnessMapUv),y.push(A.iridescenceMapUv),y.push(A.iridescenceThicknessMapUv),y.push(A.sheenColorMapUv),y.push(A.sheenRoughnessMapUv),y.push(A.specularMapUv),y.push(A.specularColorMapUv),y.push(A.specularIntensityMapUv),y.push(A.transmissionMapUv),y.push(A.thicknessMapUv),y.push(A.combine),y.push(A.fogExp2),y.push(A.sizeAttenuation),y.push(A.morphTargetsCount),y.push(A.morphAttributeCount),y.push(A.numDirLights),y.push(A.numPointLights),y.push(A.numSpotLights),y.push(A.numSpotLightMaps),y.push(A.numHemiLights),y.push(A.numRectAreaLights),y.push(A.numDirLightShadows),y.push(A.numPointLightShadows),y.push(A.numSpotLightShadows),y.push(A.numSpotLightShadowsWithMaps),y.push(A.numLightProbes),y.push(A.shadowMapType),y.push(A.toneMapping),y.push(A.numClippingPlanes),y.push(A.numClipIntersection),y.push(A.depthPacking)}function x(y,A){r.disableAll(),A.instancing&&r.enable(0),A.instancingColor&&r.enable(1),A.instancingMorph&&r.enable(2),A.matcap&&r.enable(3),A.envMap&&r.enable(4),A.normalMapObjectSpace&&r.enable(5),A.normalMapTangentSpace&&r.enable(6),A.clearcoat&&r.enable(7),A.iridescence&&r.enable(8),A.alphaTest&&r.enable(9),A.vertexColors&&r.enable(10),A.vertexAlphas&&r.enable(11),A.vertexUv1s&&r.enable(12),A.vertexUv2s&&r.enable(13),A.vertexUv3s&&r.enable(14),A.vertexTangents&&r.enable(15),A.anisotropy&&r.enable(16),A.alphaHash&&r.enable(17),A.batching&&r.enable(18),A.dispersion&&r.enable(19),A.batchingColor&&r.enable(20),A.gradientMap&&r.enable(21),A.packedNormalMap&&r.enable(22),A.vertexNormals&&r.enable(23),y.push(r.mask),r.disableAll(),A.fog&&r.enable(0),A.useFog&&r.enable(1),A.flatShading&&r.enable(2),A.logarithmicDepthBuffer&&r.enable(3),A.reversedDepthBuffer&&r.enable(4),A.skinning&&r.enable(5),A.morphTargets&&r.enable(6),A.morphNormals&&r.enable(7),A.morphColors&&r.enable(8),A.premultipliedAlpha&&r.enable(9),A.shadowMapEnabled&&r.enable(10),A.doubleSided&&r.enable(11),A.flipSided&&r.enable(12),A.useDepthPacking&&r.enable(13),A.dithering&&r.enable(14),A.transmission&&r.enable(15),A.sheen&&r.enable(16),A.opaque&&r.enable(17),A.pointsUvs&&r.enable(18),A.decodeVideoTexture&&r.enable(19),A.decodeVideoTextureEmissive&&r.enable(20),A.alphaToCoverage&&r.enable(21),A.numLightProbeGrids>0&&r.enable(22),A.hasPositionAttribute&&r.enable(23),y.push(r.mask)}function S(y){let A=h[y.type],E;if(A){let w=kn[A];E=T0.clone(w.uniforms)}else E=y.uniforms;return E}function _(y,A){let E=d.get(A);return E!==void 0?++E.usedTimes:(E=new _T(t,A,y,i),u.push(E),d.set(A,E)),E}function L(y){if(--y.usedTimes===0){let A=u.indexOf(y);u[A]=u[u.length-1],u.pop(),d.delete(y.cacheKey),y.destroy()}}function C(y){o.remove(y)}function T(){o.dispose()}return{getParameters:b,getProgramCacheKey:m,getUniforms:S,acquireProgram:_,releaseProgram:L,releaseShaderCache:C,programs:u,dispose:T}}function CT(){let t=new WeakMap;function e(r){return t.has(r)}function a(r){let o=t.get(r);return o===void 0&&(o={},t.set(r,o)),o}function n(r){t.delete(r)}function i(r,o,l){t.get(r)[o]=l}function s(){t=new WeakMap}return{has:e,get:a,remove:n,update:i,dispose:s}}function LT(t,e){return t.groupOrder!==e.groupOrder?t.groupOrder-e.groupOrder:t.renderOrder!==e.renderOrder?t.renderOrder-e.renderOrder:t.material.id!==e.material.id?t.material.id-e.material.id:t.materialVariant!==e.materialVariant?t.materialVariant-e.materialVariant:t.z!==e.z?t.z-e.z:t.id-e.id}function Y0(t,e){return t.groupOrder!==e.groupOrder?t.groupOrder-e.groupOrder:t.renderOrder!==e.renderOrder?t.renderOrder-e.renderOrder:t.z!==e.z?e.z-t.z:t.id-e.id}function Z0(){let t=[],e=0,a=[],n=[],i=[];function s(){e=0,a.length=0,n.length=0,i.length=0}function r(c){let h=0;return c.isInstancedMesh&&(h+=2),c.isSkinnedMesh&&(h+=1),h}function o(c,h,v,b,m,f){let x=t[e];return x===void 0?(x={id:c.id,object:c,geometry:h,material:v,materialVariant:r(c),groupOrder:b,renderOrder:c.renderOrder,z:m,group:f},t[e]=x):(x.id=c.id,x.object=c,x.geometry=h,x.material=v,x.materialVariant=r(c),x.groupOrder=b,x.renderOrder=c.renderOrder,x.z=m,x.group=f),e++,x}function l(c,h,v,b,m,f){let x=o(c,h,v,b,m,f);v.transmission>0?n.push(x):v.transparent===!0?i.push(x):a.push(x)}function u(c,h,v,b,m,f){let x=o(c,h,v,b,m,f);v.transmission>0?n.unshift(x):v.transparent===!0?i.unshift(x):a.unshift(x)}function d(c,h,v){a.length>1&&a.sort(c||LT),n.length>1&&n.sort(h||Y0),i.length>1&&i.sort(h||Y0),v&&(a.reverse(),n.reverse(),i.reverse())}function p(){for(let c=e,h=t.length;c<h;c++){let v=t[c];if(v.id===null)break;v.id=null,v.object=null,v.geometry=null,v.material=null,v.group=null}}return{opaque:a,transmissive:n,transparent:i,init:s,push:l,unshift:u,finish:p,sort:d}}function AT(){let t=new WeakMap;function e(n,i){let s=t.get(n),r;return s===void 0?(r=new Z0,t.set(n,[r])):i>=s.length?(r=new Z0,s.push(r)):r=s[i],r}function a(){t=new WeakMap}return{get:e,dispose:a}}function TT(){let t={};return{get:function(e){if(t[e.id]!==void 0)return t[e.id];let a;switch(e.type){case"DirectionalLight":a={direction:new F,color:new Je};break;case"SpotLight":a={position:new F,direction:new F,color:new Je,distance:0,coneCos:0,penumbraCos:0,decay:0};break;case"PointLight":a={position:new F,color:new Je,distance:0,decay:0};break;case"HemisphereLight":a={direction:new F,skyColor:new Je,groundColor:new Je};break;case"RectAreaLight":a={color:new Je,position:new F,halfWidth:new F,halfHeight:new F};break}return t[e.id]=a,a}}}function IT(){let t={};return{get:function(e){if(t[e.id]!==void 0)return t[e.id];let a;switch(e.type){case"DirectionalLight":a={shadowIntensity:1,shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new qe};break;case"SpotLight":a={shadowIntensity:1,shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new qe};break;case"PointLight":a={shadowIntensity:1,shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new qe,shadowCameraNear:1,shadowCameraFar:1e3};break}return t[e.id]=a,a}}}var ET=0;function wT(t,e){return(e.castShadow?2:0)-(t.castShadow?2:0)+(e.map?1:0)-(t.map?1:0)}function RT(t){let e=new TT,a=IT(),n={version:0,hash:{directionalLength:-1,pointLength:-1,spotLength:-1,rectAreaLength:-1,hemiLength:-1,numDirectionalShadows:-1,numPointShadows:-1,numSpotShadows:-1,numSpotMaps:-1,numLightProbes:-1},ambient:[0,0,0],probe:[],directional:[],directionalShadow:[],directionalShadowMap:[],directionalShadowMatrix:[],spot:[],spotLightMap:[],spotShadow:[],spotShadowMap:[],spotLightMatrix:[],rectArea:[],rectAreaLTC1:null,rectAreaLTC2:null,point:[],pointShadow:[],pointShadowMap:[],pointShadowMatrix:[],hemi:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};for(let u=0;u<9;u++)n.probe.push(new F);let i=new F,s=new Ot,r=new Ot;function o(u){let d=0,p=0,c=0;for(let A=0;A<9;A++)n.probe[A].set(0,0,0);let h=0,v=0,b=0,m=0,f=0,x=0,S=0,_=0,L=0,C=0,T=0;u.sort(wT);for(let A=0,E=u.length;A<E;A++){let w=u[A],B=w.color,X=w.intensity,K=w.distance,z=null;if(w.shadow&&w.shadow.map&&(w.shadow.map.texture.format===Xi?z=w.shadow.map.texture:z=w.shadow.map.depthTexture||w.shadow.map.texture),w.isAmbientLight)d+=B.r*X,p+=B.g*X,c+=B.b*X;else if(w.isLightProbe){for(let W=0;W<9;W++)n.probe[W].addScaledVector(w.sh.coefficients[W],X);T++}else if(w.isDirectionalLight){let W=e.get(w);if(W.color.copy(w.color).multiplyScalar(w.intensity),w.castShadow){let V=w.shadow,j=a.get(w);j.shadowIntensity=V.intensity,j.shadowBias=V.bias,j.shadowNormalBias=V.normalBias,j.shadowRadius=V.radius,j.shadowMapSize=V.mapSize,n.directionalShadow[h]=j,n.directionalShadowMap[h]=z,n.directionalShadowMatrix[h]=w.shadow.matrix,x++}n.directional[h]=W,h++}else if(w.isSpotLight){let W=e.get(w);W.position.setFromMatrixPosition(w.matrixWorld),W.color.copy(B).multiplyScalar(X),W.distance=K,W.coneCos=Math.cos(w.angle),W.penumbraCos=Math.cos(w.angle*(1-w.penumbra)),W.decay=w.decay,n.spot[b]=W;let V=w.shadow;if(w.map&&(n.spotLightMap[L]=w.map,L++,V.updateMatrices(w),w.castShadow&&C++),n.spotLightMatrix[b]=V.matrix,w.castShadow){let j=a.get(w);j.shadowIntensity=V.intensity,j.shadowBias=V.bias,j.shadowNormalBias=V.normalBias,j.shadowRadius=V.radius,j.shadowMapSize=V.mapSize,n.spotShadow[b]=j,n.spotShadowMap[b]=z,_++}b++}else if(w.isRectAreaLight){let W=e.get(w);W.color.copy(B).multiplyScalar(X),W.halfWidth.set(w.width*.5,0,0),W.halfHeight.set(0,w.height*.5,0),n.rectArea[m]=W,m++}else if(w.isPointLight){let W=e.get(w);if(W.color.copy(w.color).multiplyScalar(w.intensity),W.distance=w.distance,W.decay=w.decay,w.castShadow){let V=w.shadow,j=a.get(w);j.shadowIntensity=V.intensity,j.shadowBias=V.bias,j.shadowNormalBias=V.normalBias,j.shadowRadius=V.radius,j.shadowMapSize=V.mapSize,j.shadowCameraNear=V.camera.near,j.shadowCameraFar=V.camera.far,n.pointShadow[v]=j,n.pointShadowMap[v]=z,n.pointShadowMatrix[v]=w.shadow.matrix,S++}n.point[v]=W,v++}else if(w.isHemisphereLight){let W=e.get(w);W.skyColor.copy(w.color).multiplyScalar(X),W.groundColor.copy(w.groundColor).multiplyScalar(X),n.hemi[f]=W,f++}}m>0&&(t.has("OES_texture_float_linear")===!0?(n.rectAreaLTC1=ce.LTC_FLOAT_1,n.rectAreaLTC2=ce.LTC_FLOAT_2):(n.rectAreaLTC1=ce.LTC_HALF_1,n.rectAreaLTC2=ce.LTC_HALF_2)),n.ambient[0]=d,n.ambient[1]=p,n.ambient[2]=c;let y=n.hash;(y.directionalLength!==h||y.pointLength!==v||y.spotLength!==b||y.rectAreaLength!==m||y.hemiLength!==f||y.numDirectionalShadows!==x||y.numPointShadows!==S||y.numSpotShadows!==_||y.numSpotMaps!==L||y.numLightProbes!==T)&&(n.directional.length=h,n.spot.length=b,n.rectArea.length=m,n.point.length=v,n.hemi.length=f,n.directionalShadow.length=x,n.directionalShadowMap.length=x,n.pointShadow.length=S,n.pointShadowMap.length=S,n.spotShadow.length=_,n.spotShadowMap.length=_,n.directionalShadowMatrix.length=x,n.pointShadowMatrix.length=S,n.spotLightMatrix.length=_+L-C,n.spotLightMap.length=L,n.numSpotLightShadowsWithMaps=C,n.numLightProbes=T,y.directionalLength=h,y.pointLength=v,y.spotLength=b,y.rectAreaLength=m,y.hemiLength=f,y.numDirectionalShadows=x,y.numPointShadows=S,y.numSpotShadows=_,y.numSpotMaps=L,y.numLightProbes=T,n.version=ET++)}function l(u,d){let p=0,c=0,h=0,v=0,b=0,m=d.matrixWorldInverse;for(let f=0,x=u.length;f<x;f++){let S=u[f];if(S.isDirectionalLight){let _=n.directional[p];_.direction.setFromMatrixPosition(S.matrixWorld),i.setFromMatrixPosition(S.target.matrixWorld),_.direction.sub(i),_.direction.transformDirection(m),p++}else if(S.isSpotLight){let _=n.spot[h];_.position.setFromMatrixPosition(S.matrixWorld),_.position.applyMatrix4(m),_.direction.setFromMatrixPosition(S.matrixWorld),i.setFromMatrixPosition(S.target.matrixWorld),_.direction.sub(i),_.direction.transformDirection(m),h++}else if(S.isRectAreaLight){let _=n.rectArea[v];_.position.setFromMatrixPosition(S.matrixWorld),_.position.applyMatrix4(m),r.identity(),s.copy(S.matrixWorld),s.premultiply(m),r.extractRotation(s),_.halfWidth.set(S.width*.5,0,0),_.halfHeight.set(0,S.height*.5,0),_.halfWidth.applyMatrix4(r),_.halfHeight.applyMatrix4(r),v++}else if(S.isPointLight){let _=n.point[c];_.position.setFromMatrixPosition(S.matrixWorld),_.position.applyMatrix4(m),c++}else if(S.isHemisphereLight){let _=n.hemi[b];_.direction.setFromMatrixPosition(S.matrixWorld),_.direction.transformDirection(m),b++}}}return{setup:o,setupView:l,state:n}}function K0(t){let e=new RT(t),a=[],n=[],i=[];function s(c){p.camera=c,a.length=0,n.length=0,i.length=0}function r(c){a.push(c)}function o(c){n.push(c)}function l(c){i.push(c)}function u(){e.setup(a)}function d(c){e.setupView(a,c)}let p={lightsArray:a,shadowsArray:n,lightProbeGridArray:i,camera:null,lights:e,transmissionRenderTarget:{},textureUnits:0};return{init:s,state:p,setupLights:u,setupLightsView:d,pushLight:r,pushShadow:o,pushLightProbeGrid:l}}function DT(t){let e=new WeakMap;function a(i,s=0){let r=e.get(i),o;return r===void 0?(o=new K0(t),e.set(i,[o])):s>=r.length?(o=new K0(t),r.push(o)):o=r[s],o}function n(){e=new WeakMap}return{get:a,dispose:n}}var PT=`void main() {
	gl_Position = vec4( position, 1.0 );
}`,UT=`uniform sampler2D shadow_pass;
uniform vec2 resolution;
uniform float radius;
void main() {
	const float samples = float( VSM_SAMPLES );
	float mean = 0.0;
	float squared_mean = 0.0;
	float uvStride = samples <= 1.0 ? 0.0 : 2.0 / ( samples - 1.0 );
	float uvStart = samples <= 1.0 ? 0.0 : - 1.0;
	for ( float i = 0.0; i < samples; i ++ ) {
		float uvOffset = uvStart + i * uvStride;
		#ifdef HORIZONTAL_PASS
			vec2 distribution = texture2D( shadow_pass, ( gl_FragCoord.xy + vec2( uvOffset, 0.0 ) * radius ) / resolution ).rg;
			mean += distribution.x;
			squared_mean += distribution.y * distribution.y + distribution.x * distribution.x;
		#else
			float depth = texture2D( shadow_pass, ( gl_FragCoord.xy + vec2( 0.0, uvOffset ) * radius ) / resolution ).r;
			mean += depth;
			squared_mean += depth * depth;
		#endif
	}
	mean = mean / samples;
	squared_mean = squared_mean / samples;
	float std_dev = sqrt( max( 0.0, squared_mean - mean * mean ) );
	gl_FragColor = vec4( mean, std_dev, 0.0, 1.0 );
}`,BT=[new F(1,0,0),new F(-1,0,0),new F(0,1,0),new F(0,-1,0),new F(0,0,1),new F(0,0,-1)],OT=[new F(0,-1,0),new F(0,-1,0),new F(0,0,1),new F(0,0,-1),new F(0,-1,0),new F(0,-1,0)],J0=new Ot,rl=new F,up=new F;function NT(t,e,a){let n=new Vo,i=new qe,s=new qe,r=new At,o=new ac,l=new nc,u={},d=a.maxTextureSize,p={[ai]:va,[va]:ai,[On]:On},c=new xa({defines:{VSM_SAMPLES:8},uniforms:{shadow_pass:{value:null},resolution:{value:new qe},radius:{value:4}},vertexShader:PT,fragmentShader:UT}),h=c.clone();h.defines.HORIZONTAL_PASS=1;let v=new Bn;v.setAttribute("position",new Na(new Float32Array([-1,-1,.5,3,-1,.5,-1,3,.5]),3));let b=new La(v,c),m=this;this.enabled=!1,this.autoUpdate=!0,this.needsUpdate=!1,this.type=Ko;let f=this.type;this.render=function(C,T,y){if(m.enabled===!1||m.autoUpdate===!1&&m.needsUpdate===!1||C.length===0)return;this.type===Xx&&(Ae("WebGLShadowMap: PCFSoftShadowMap has been deprecated. Using PCFShadowMap instead."),this.type=Ko);let A=t.getRenderTarget(),E=t.getActiveCubeFace(),w=t.getActiveMipmapLevel(),B=t.state;B.setBlending(Nn),B.buffers.depth.getReversed()===!0?B.buffers.color.setClear(0,0,0,0):B.buffers.color.setClear(1,1,1,1),B.buffers.depth.setTest(!0),B.setScissorTest(!1);let X=f!==this.type;X&&T.traverse(function(K){K.material&&(Array.isArray(K.material)?K.material.forEach(z=>z.needsUpdate=!0):K.material.needsUpdate=!0)});for(let K=0,z=C.length;K<z;K++){let W=C[K],V=W.shadow;if(V===void 0){Ae("WebGLShadowMap:",W,"has no shadow.");continue}if(V.autoUpdate===!1&&V.needsUpdate===!1)continue;i.copy(V.mapSize);let j=V.getFrameExtents();i.multiply(j),s.copy(V.mapSize),(i.x>d||i.y>d)&&(i.x>d&&(s.x=Math.floor(d/j.x),i.x=s.x*j.x,V.mapSize.x=s.x),i.y>d&&(s.y=Math.floor(d/j.y),i.y=s.y*j.y,V.mapSize.y=s.y));let ee=t.state.buffers.depth.getReversed();if(V.camera._reversedDepth=ee,V.map===null||X===!0){if(V.map!==null&&(V.map.depthTexture!==null&&(V.map.depthTexture.dispose(),V.map.depthTexture=null),V.map.dispose()),this.type===Ar){if(W.isPointLight){Ae("WebGLShadowMap: VSM shadow maps are not supported for PointLights. Use PCF or BasicShadowMap instead.");continue}V.map=new Fa(i.x,i.y,{format:Xi,type:Fn,minFilter:ia,magFilter:ia,generateMipmaps:!1}),V.map.texture.name=W.name+".shadowMap",V.map.depthTexture=new ni(i.x,i.y,_n),V.map.depthTexture.name=W.name+".shadowMapDepth",V.map.depthTexture.format=Dn,V.map.depthTexture.compareFunction=null,V.map.depthTexture.minFilter=$t,V.map.depthTexture.magFilter=$t}else W.isPointLight?(V.map=new of(i.x),V.map.depthTexture=new ec(i.x,yn)):(V.map=new Fa(i.x,i.y),V.map.depthTexture=new ni(i.x,i.y,yn)),V.map.depthTexture.name=W.name+".shadowMap",V.map.depthTexture.format=Dn,this.type===Ko?(V.map.depthTexture.compareFunction=ee?af:tf,V.map.depthTexture.minFilter=ia,V.map.depthTexture.magFilter=ia):(V.map.depthTexture.compareFunction=null,V.map.depthTexture.minFilter=$t,V.map.depthTexture.magFilter=$t);V.camera.updateProjectionMatrix()}let fe=V.map.isWebGLCubeRenderTarget?6:1;for(let me=0;me<fe;me++){if(V.map.isWebGLCubeRenderTarget)t.setRenderTarget(V.map,me),t.clear();else{me===0&&(t.setRenderTarget(V.map),t.clear());let ve=V.getViewport(me);r.set(s.x*ve.x,s.y*ve.y,s.x*ve.z,s.y*ve.w),B.viewport(r)}if(W.isPointLight){let ve=V.camera,Qe=V.matrix,Tt=W.distance||ve.far;Tt!==ve.far&&(ve.far=Tt,ve.updateProjectionMatrix()),rl.setFromMatrixPosition(W.matrixWorld),ve.position.copy(rl),up.copy(ve.position),up.add(BT[me]),ve.up.copy(OT[me]),ve.lookAt(up),ve.updateMatrixWorld(),Qe.makeTranslation(-rl.x,-rl.y,-rl.z),J0.multiplyMatrices(ve.projectionMatrix,ve.matrixWorldInverse),V._frustum.setFromProjectionMatrix(J0,ve.coordinateSystem,ve.reversedDepth)}else V.updateMatrices(W);n=V.getFrustum(),_(T,y,V.camera,W,this.type)}V.isPointLightShadow!==!0&&this.type===Ar&&x(V,y),V.needsUpdate=!1}f=this.type,m.needsUpdate=!1,t.setRenderTarget(A,E,w)};function x(C,T){let y=e.update(b);c.defines.VSM_SAMPLES!==C.blurSamples&&(c.defines.VSM_SAMPLES=C.blurSamples,h.defines.VSM_SAMPLES=C.blurSamples,c.needsUpdate=!0,h.needsUpdate=!0),C.mapPass===null&&(C.mapPass=new Fa(i.x,i.y,{format:Xi,type:Fn})),c.uniforms.shadow_pass.value=C.map.depthTexture,c.uniforms.resolution.value=C.mapSize,c.uniforms.radius.value=C.radius,t.setRenderTarget(C.mapPass),t.clear(),t.renderBufferDirect(T,null,y,c,b,null),h.uniforms.shadow_pass.value=C.mapPass.texture,h.uniforms.resolution.value=C.mapSize,h.uniforms.radius.value=C.radius,t.setRenderTarget(C.map),t.clear(),t.renderBufferDirect(T,null,y,h,b,null)}function S(C,T,y,A){let E=null,w=y.isPointLight===!0?C.customDistanceMaterial:C.customDepthMaterial;if(w!==void 0)E=w;else if(E=y.isPointLight===!0?l:o,t.localClippingEnabled&&T.clipShadows===!0&&Array.isArray(T.clippingPlanes)&&T.clippingPlanes.length!==0||T.displacementMap&&T.displacementScale!==0||T.alphaMap&&T.alphaTest>0||T.map&&T.alphaTest>0||T.alphaToCoverage===!0){let B=E.uuid,X=T.uuid,K=u[B];K===void 0&&(K={},u[B]=K);let z=K[X];z===void 0&&(z=E.clone(),K[X]=z,T.addEventListener("dispose",L)),E=z}if(E.visible=T.visible,E.wireframe=T.wireframe,A===Ar?E.side=T.shadowSide!==null?T.shadowSide:T.side:E.side=T.shadowSide!==null?T.shadowSide:p[T.side],E.alphaMap=T.alphaMap,E.alphaTest=T.alphaToCoverage===!0?.5:T.alphaTest,E.map=T.map,E.clipShadows=T.clipShadows,E.clippingPlanes=T.clippingPlanes,E.clipIntersection=T.clipIntersection,E.displacementMap=T.displacementMap,E.displacementScale=T.displacementScale,E.displacementBias=T.displacementBias,E.wireframeLinewidth=T.wireframeLinewidth,E.linewidth=T.linewidth,y.isPointLight===!0&&E.isMeshDistanceMaterial===!0){let B=t.properties.get(E);B.light=y}return E}function _(C,T,y,A,E){if(C.visible===!1)return;if(C.layers.test(T.layers)&&(C.isMesh||C.isLine||C.isPoints)&&(C.castShadow||C.receiveShadow&&E===Ar)&&(!C.frustumCulled||n.intersectsObject(C))){C.modelViewMatrix.multiplyMatrices(y.matrixWorldInverse,C.matrixWorld);let X=e.update(C),K=C.material;if(Array.isArray(K)){let z=X.groups;for(let W=0,V=z.length;W<V;W++){let j=z[W],ee=K[j.materialIndex];if(ee&&ee.visible){let fe=S(C,ee,A,E);C.onBeforeShadow(t,C,T,y,X,fe,j),t.renderBufferDirect(y,null,X,fe,C,j),C.onAfterShadow(t,C,T,y,X,fe,j)}}}else if(K.visible){let z=S(C,K,A,E);C.onBeforeShadow(t,C,T,y,X,z,null),t.renderBufferDirect(y,null,X,z,C,null),C.onAfterShadow(t,C,T,y,X,z,null)}}let B=C.children;for(let X=0,K=B.length;X<K;X++)_(B[X],T,y,A,E)}function L(C){C.target.removeEventListener("dispose",L);for(let y in u){let A=u[y],E=C.target.uuid;E in A&&(A[E].dispose(),delete A[E])}}}function FT(t,e){function a(){let R=!1,ne=new At,Y=null,le=new At(0,0,0,0);return{setMask:function(pe){Y!==pe&&!R&&(t.colorMask(pe,pe,pe,pe),Y=pe)},setLocked:function(pe){R=pe},setClear:function(pe,$,Se,ye,Et){Et===!0&&(pe*=ye,$*=ye,Se*=ye),ne.set(pe,$,Se,ye),le.equals(ne)===!1&&(t.clearColor(pe,$,Se,ye),le.copy(ne))},reset:function(){R=!1,Y=null,le.set(-1,0,0,0)}}}function n(){let R=!1,ne=!1,Y=null,le=null,pe=null;return{setReversed:function($){if(ne!==$){let Se=e.get("EXT_clip_control");$?Se.clipControlEXT(Se.LOWER_LEFT_EXT,Se.ZERO_TO_ONE_EXT):Se.clipControlEXT(Se.LOWER_LEFT_EXT,Se.NEGATIVE_ONE_TO_ONE_EXT),ne=$;let ye=pe;pe=null,this.setClear(ye)}},getReversed:function(){return ne},setTest:function($){$?te(t.DEPTH_TEST):Re(t.DEPTH_TEST)},setMask:function($){Y!==$&&!R&&(t.depthMask($),Y=$)},setFunc:function($){if(ne&&($=L0[$]),le!==$){switch($){case Fu:t.depthFunc(t.NEVER);break;case zu:t.depthFunc(t.ALWAYS);break;case ku:t.depthFunc(t.LESS);break;case Rs:t.depthFunc(t.LEQUAL);break;case Hu:t.depthFunc(t.EQUAL);break;case Vu:t.depthFunc(t.GEQUAL);break;case Gu:t.depthFunc(t.GREATER);break;case qu:t.depthFunc(t.NOTEQUAL);break;default:t.depthFunc(t.LEQUAL)}le=$}},setLocked:function($){R=$},setClear:function($){pe!==$&&(pe=$,ne&&($=1-$),t.clearDepth($))},reset:function(){R=!1,Y=null,le=null,pe=null,ne=!1}}}function i(){let R=!1,ne=null,Y=null,le=null,pe=null,$=null,Se=null,ye=null,Et=null;return{setTest:function(ht){R||(ht?te(t.STENCIL_TEST):Re(t.STENCIL_TEST))},setMask:function(ht){ne!==ht&&!R&&(t.stencilMask(ht),ne=ht)},setFunc:function(ht,Ln,An){(Y!==ht||le!==Ln||pe!==An)&&(t.stencilFunc(ht,Ln,An),Y=ht,le=Ln,pe=An)},setOp:function(ht,Ln,An){($!==ht||Se!==Ln||ye!==An)&&(t.stencilOp(ht,Ln,An),$=ht,Se=Ln,ye=An)},setLocked:function(ht){R=ht},setClear:function(ht){Et!==ht&&(t.clearStencil(ht),Et=ht)},reset:function(){R=!1,ne=null,Y=null,le=null,pe=null,$=null,Se=null,ye=null,Et=null}}}let s=new a,r=new n,o=new i,l=new WeakMap,u=new WeakMap,d={},p={},c={},h=new WeakMap,v=[],b=null,m=!1,f=null,x=null,S=null,_=null,L=null,C=null,T=null,y=new Je(0,0,0),A=0,E=!1,w=null,B=null,X=null,K=null,z=null,W=t.getParameter(t.MAX_COMBINED_TEXTURE_IMAGE_UNITS),V=!1,j=0,ee=t.getParameter(t.VERSION);ee.indexOf("WebGL")!==-1?(j=parseFloat(/^WebGL (\d)/.exec(ee)[1]),V=j>=1):ee.indexOf("OpenGL ES")!==-1&&(j=parseFloat(/^OpenGL ES (\d)/.exec(ee)[1]),V=j>=2);let fe=null,me={},ve=t.getParameter(t.SCISSOR_BOX),Qe=t.getParameter(t.VIEWPORT),Tt=new At().fromArray(ve),je=new At().fromArray(Qe);function J(R,ne,Y,le){let pe=new Uint8Array(4),$=t.createTexture();t.bindTexture(R,$),t.texParameteri(R,t.TEXTURE_MIN_FILTER,t.NEAREST),t.texParameteri(R,t.TEXTURE_MAG_FILTER,t.NEAREST);for(let Se=0;Se<Y;Se++)R===t.TEXTURE_3D||R===t.TEXTURE_2D_ARRAY?t.texImage3D(ne,0,t.RGBA,1,1,le,0,t.RGBA,t.UNSIGNED_BYTE,pe):t.texImage2D(ne+Se,0,t.RGBA,1,1,0,t.RGBA,t.UNSIGNED_BYTE,pe);return $}let ie={};ie[t.TEXTURE_2D]=J(t.TEXTURE_2D,t.TEXTURE_2D,1),ie[t.TEXTURE_CUBE_MAP]=J(t.TEXTURE_CUBE_MAP,t.TEXTURE_CUBE_MAP_POSITIVE_X,6),ie[t.TEXTURE_2D_ARRAY]=J(t.TEXTURE_2D_ARRAY,t.TEXTURE_2D_ARRAY,1,1),ie[t.TEXTURE_3D]=J(t.TEXTURE_3D,t.TEXTURE_3D,1,1),s.setClear(0,0,0,1),r.setClear(1),o.setClear(0),te(t.DEPTH_TEST),r.setFunc(Rs),zt(!1),Xt(Rh),te(t.CULL_FACE),$e(Nn);function te(R){d[R]!==!0&&(t.enable(R),d[R]=!0)}function Re(R){d[R]!==!1&&(t.disable(R),d[R]=!1)}function Ue(R,ne){return c[R]!==ne?(t.bindFramebuffer(R,ne),c[R]=ne,R===t.DRAW_FRAMEBUFFER&&(c[t.FRAMEBUFFER]=ne),R===t.FRAMEBUFFER&&(c[t.DRAW_FRAMEBUFFER]=ne),!0):!1}function Te(R,ne){let Y=v,le=!1;if(R){Y=h.get(ne),Y===void 0&&(Y=[],h.set(ne,Y));let pe=R.textures;if(Y.length!==pe.length||Y[0]!==t.COLOR_ATTACHMENT0){for(let $=0,Se=pe.length;$<Se;$++)Y[$]=t.COLOR_ATTACHMENT0+$;Y.length=pe.length,le=!0}}else Y[0]!==t.BACK&&(Y[0]=t.BACK,le=!0);le&&t.drawBuffers(Y)}function Pt(R){return b!==R?(t.useProgram(R),b=R,!0):!1}let Ve={[Ni]:t.FUNC_ADD,[Zx]:t.FUNC_SUBTRACT,[Kx]:t.FUNC_REVERSE_SUBTRACT};Ve[Jx]=t.MIN,Ve[Qx]=t.MAX;let ut={[jx]:t.ZERO,[$x]:t.ONE,[e0]:t.SRC_COLOR,[Ou]:t.SRC_ALPHA,[r0]:t.SRC_ALPHA_SATURATE,[i0]:t.DST_COLOR,[a0]:t.DST_ALPHA,[t0]:t.ONE_MINUS_SRC_COLOR,[Nu]:t.ONE_MINUS_SRC_ALPHA,[s0]:t.ONE_MINUS_DST_COLOR,[n0]:t.ONE_MINUS_DST_ALPHA,[o0]:t.CONSTANT_COLOR,[l0]:t.ONE_MINUS_CONSTANT_COLOR,[u0]:t.CONSTANT_ALPHA,[c0]:t.ONE_MINUS_CONSTANT_ALPHA};function $e(R,ne,Y,le,pe,$,Se,ye,Et,ht){if(R===Nn){m===!0&&(Re(t.BLEND),m=!1);return}if(m===!1&&(te(t.BLEND),m=!0),R!==Yx){if(R!==f||ht!==E){if((x!==Ni||L!==Ni)&&(t.blendEquation(t.FUNC_ADD),x=Ni,L=Ni),ht)switch(R){case ws:t.blendFuncSeparate(t.ONE,t.ONE_MINUS_SRC_ALPHA,t.ONE,t.ONE_MINUS_SRC_ALPHA);break;case Dh:t.blendFunc(t.ONE,t.ONE);break;case Ph:t.blendFuncSeparate(t.ZERO,t.ONE_MINUS_SRC_COLOR,t.ZERO,t.ONE);break;case Uh:t.blendFuncSeparate(t.DST_COLOR,t.ONE_MINUS_SRC_ALPHA,t.ZERO,t.ONE);break;default:Ee("WebGLState: Invalid blending: ",R);break}else switch(R){case ws:t.blendFuncSeparate(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA,t.ONE,t.ONE_MINUS_SRC_ALPHA);break;case Dh:t.blendFuncSeparate(t.SRC_ALPHA,t.ONE,t.ONE,t.ONE);break;case Ph:Ee("WebGLState: SubtractiveBlending requires material.premultipliedAlpha = true");break;case Uh:Ee("WebGLState: MultiplyBlending requires material.premultipliedAlpha = true");break;default:Ee("WebGLState: Invalid blending: ",R);break}S=null,_=null,C=null,T=null,y.set(0,0,0),A=0,f=R,E=ht}return}pe=pe||ne,$=$||Y,Se=Se||le,(ne!==x||pe!==L)&&(t.blendEquationSeparate(Ve[ne],Ve[pe]),x=ne,L=pe),(Y!==S||le!==_||$!==C||Se!==T)&&(t.blendFuncSeparate(ut[Y],ut[le],ut[$],ut[Se]),S=Y,_=le,C=$,T=Se),(ye.equals(y)===!1||Et!==A)&&(t.blendColor(ye.r,ye.g,ye.b,Et),y.copy(ye),A=Et),f=R,E=!1}function Ze(R,ne){R.side===On?Re(t.CULL_FACE):te(t.CULL_FACE);let Y=R.side===va;ne&&(Y=!Y),zt(Y),R.blending===ws&&R.transparent===!1?$e(Nn):$e(R.blending,R.blendEquation,R.blendSrc,R.blendDst,R.blendEquationAlpha,R.blendSrcAlpha,R.blendDstAlpha,R.blendColor,R.blendAlpha,R.premultipliedAlpha),r.setFunc(R.depthFunc),r.setTest(R.depthTest),r.setMask(R.depthWrite),s.setMask(R.colorWrite);let le=R.stencilWrite;o.setTest(le),le&&(o.setMask(R.stencilWriteMask),o.setFunc(R.stencilFunc,R.stencilRef,R.stencilFuncMask),o.setOp(R.stencilFail,R.stencilZFail,R.stencilZPass)),na(R.polygonOffset,R.polygonOffsetFactor,R.polygonOffsetUnits),R.alphaToCoverage===!0?te(t.SAMPLE_ALPHA_TO_COVERAGE):Re(t.SAMPLE_ALPHA_TO_COVERAGE)}function zt(R){w!==R&&(R?t.frontFace(t.CW):t.frontFace(t.CCW),w=R)}function Xt(R){R!==qx?(te(t.CULL_FACE),R!==B&&(R===Rh?t.cullFace(t.BACK):R===Wx?t.cullFace(t.FRONT):t.cullFace(t.FRONT_AND_BACK))):Re(t.CULL_FACE),B=R}function Qt(R){R!==X&&(V&&t.lineWidth(R),X=R)}function na(R,ne,Y){R?(te(t.POLYGON_OFFSET_FILL),(K!==ne||z!==Y)&&(K=ne,z=Y,r.getReversed()&&(ne=-ne),t.polygonOffset(ne,Y))):Re(t.POLYGON_OFFSET_FILL)}function It(R){R?te(t.SCISSOR_TEST):Re(t.SCISSOR_TEST)}function kt(R){R===void 0&&(R=t.TEXTURE0+W-1),fe!==R&&(t.activeTexture(R),fe=R)}function D(R,ne,Y){Y===void 0&&(fe===null?Y=t.TEXTURE0+W-1:Y=fe);let le=me[Y];le===void 0&&(le={type:void 0,texture:void 0},me[Y]=le),(le.type!==R||le.texture!==ne)&&(fe!==Y&&(t.activeTexture(Y),fe=Y),t.bindTexture(R,ne||ie[R]),le.type=R,le.texture=ne)}function Ma(){let R=me[fe];R!==void 0&&R.type!==void 0&&(t.bindTexture(R.type,null),R.type=void 0,R.texture=void 0)}function nt(){try{t.compressedTexImage2D(...arguments)}catch(R){Ee("WebGLState:",R)}}function I(){try{t.compressedTexImage3D(...arguments)}catch(R){Ee("WebGLState:",R)}}function g(){try{t.texSubImage2D(...arguments)}catch(R){Ee("WebGLState:",R)}}function U(){try{t.texSubImage3D(...arguments)}catch(R){Ee("WebGLState:",R)}}function k(){try{t.compressedTexSubImage2D(...arguments)}catch(R){Ee("WebGLState:",R)}}function G(){try{t.compressedTexSubImage3D(...arguments)}catch(R){Ee("WebGLState:",R)}}function ae(){try{t.texStorage2D(...arguments)}catch(R){Ee("WebGLState:",R)}}function se(){try{t.texStorage3D(...arguments)}catch(R){Ee("WebGLState:",R)}}function q(){try{t.texImage2D(...arguments)}catch(R){Ee("WebGLState:",R)}}function Z(){try{t.texImage3D(...arguments)}catch(R){Ee("WebGLState:",R)}}function re(R){return p[R]!==void 0?p[R]:t.getParameter(R)}function Me(R,ne){p[R]!==ne&&(t.pixelStorei(R,ne),p[R]=ne)}function ue(R){Tt.equals(R)===!1&&(t.scissor(R.x,R.y,R.z,R.w),Tt.copy(R))}function oe(R){je.equals(R)===!1&&(t.viewport(R.x,R.y,R.z,R.w),je.copy(R))}function Le(R,ne){let Y=u.get(ne);Y===void 0&&(Y=new WeakMap,u.set(ne,Y));let le=Y.get(R);le===void 0&&(le=t.getUniformBlockIndex(ne,R.name),Y.set(R,le))}function Ie(R,ne){let le=u.get(ne).get(R);l.get(ne)!==le&&(t.uniformBlockBinding(ne,le,R.__bindingPointIndex),l.set(ne,le))}function Be(){t.disable(t.BLEND),t.disable(t.CULL_FACE),t.disable(t.DEPTH_TEST),t.disable(t.POLYGON_OFFSET_FILL),t.disable(t.SCISSOR_TEST),t.disable(t.STENCIL_TEST),t.disable(t.SAMPLE_ALPHA_TO_COVERAGE),t.blendEquation(t.FUNC_ADD),t.blendFunc(t.ONE,t.ZERO),t.blendFuncSeparate(t.ONE,t.ZERO,t.ONE,t.ZERO),t.blendColor(0,0,0,0),t.colorMask(!0,!0,!0,!0),t.clearColor(0,0,0,0),t.depthMask(!0),t.depthFunc(t.LESS),r.setReversed(!1),t.clearDepth(1),t.stencilMask(4294967295),t.stencilFunc(t.ALWAYS,0,4294967295),t.stencilOp(t.KEEP,t.KEEP,t.KEEP),t.clearStencil(0),t.cullFace(t.BACK),t.frontFace(t.CCW),t.polygonOffset(0,0),t.activeTexture(t.TEXTURE0),t.bindFramebuffer(t.FRAMEBUFFER,null),t.bindFramebuffer(t.DRAW_FRAMEBUFFER,null),t.bindFramebuffer(t.READ_FRAMEBUFFER,null),t.useProgram(null),t.lineWidth(1),t.scissor(0,0,t.canvas.width,t.canvas.height),t.viewport(0,0,t.canvas.width,t.canvas.height),t.pixelStorei(t.PACK_ALIGNMENT,4),t.pixelStorei(t.UNPACK_ALIGNMENT,4),t.pixelStorei(t.UNPACK_FLIP_Y_WEBGL,!1),t.pixelStorei(t.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!1),t.pixelStorei(t.UNPACK_COLORSPACE_CONVERSION_WEBGL,t.BROWSER_DEFAULT_WEBGL),t.pixelStorei(t.PACK_ROW_LENGTH,0),t.pixelStorei(t.PACK_SKIP_PIXELS,0),t.pixelStorei(t.PACK_SKIP_ROWS,0),t.pixelStorei(t.UNPACK_ROW_LENGTH,0),t.pixelStorei(t.UNPACK_IMAGE_HEIGHT,0),t.pixelStorei(t.UNPACK_SKIP_PIXELS,0),t.pixelStorei(t.UNPACK_SKIP_ROWS,0),t.pixelStorei(t.UNPACK_SKIP_IMAGES,0),d={},p={},fe=null,me={},c={},h=new WeakMap,v=[],b=null,m=!1,f=null,x=null,S=null,_=null,L=null,C=null,T=null,y=new Je(0,0,0),A=0,E=!1,w=null,B=null,X=null,K=null,z=null,Tt.set(0,0,t.canvas.width,t.canvas.height),je.set(0,0,t.canvas.width,t.canvas.height),s.reset(),r.reset(),o.reset()}return{buffers:{color:s,depth:r,stencil:o},enable:te,disable:Re,bindFramebuffer:Ue,drawBuffers:Te,useProgram:Pt,setBlending:$e,setMaterial:Ze,setFlipSided:zt,setCullFace:Xt,setLineWidth:Qt,setPolygonOffset:na,setScissorTest:It,activeTexture:kt,bindTexture:D,unbindTexture:Ma,compressedTexImage2D:nt,compressedTexImage3D:I,texImage2D:q,texImage3D:Z,pixelStorei:Me,getParameter:re,updateUBOMapping:Le,uniformBlockBinding:Ie,texStorage2D:ae,texStorage3D:se,texSubImage2D:g,texSubImage3D:U,compressedTexSubImage2D:k,compressedTexSubImage3D:G,scissor:ue,viewport:oe,reset:Be}}function zT(t,e,a,n,i,s,r){let o=e.has("WEBGL_multisampled_render_to_texture")?e.get("WEBGL_multisampled_render_to_texture"):null,l=typeof navigator>"u"?!1:/OculusBrowser/g.test(navigator.userAgent),u=new qe,d=new WeakMap,p=new Set,c,h=new WeakMap,v=!1;try{v=typeof OffscreenCanvas<"u"&&new OffscreenCanvas(1,1).getContext("2d")!==null}catch{}function b(I,g){return v?new OffscreenCanvas(I,g):Bo("canvas")}function m(I,g,U){let k=1,G=nt(I);if((G.width>U||G.height>U)&&(k=U/Math.max(G.width,G.height)),k<1)if(typeof HTMLImageElement<"u"&&I instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&I instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&I instanceof ImageBitmap||typeof VideoFrame<"u"&&I instanceof VideoFrame){let ae=Math.floor(k*G.width),se=Math.floor(k*G.height);c===void 0&&(c=b(ae,se));let q=g?b(ae,se):c;return q.width=ae,q.height=se,q.getContext("2d").drawImage(I,0,0,ae,se),Ae("WebGLRenderer: Texture has been resized from ("+G.width+"x"+G.height+") to ("+ae+"x"+se+")."),q}else return"data"in I&&Ae("WebGLRenderer: Image in DataTexture is too big ("+G.width+"x"+G.height+")."),I;return I}function f(I){return I.generateMipmaps}function x(I){t.generateMipmap(I)}function S(I){return I.isWebGLCubeRenderTarget?t.TEXTURE_CUBE_MAP:I.isWebGL3DRenderTarget?t.TEXTURE_3D:I.isWebGLArrayRenderTarget||I.isCompressedArrayTexture?t.TEXTURE_2D_ARRAY:t.TEXTURE_2D}function _(I,g,U,k,G,ae=!1){if(I!==null){if(t[I]!==void 0)return t[I];Ae("WebGLRenderer: Attempt to use non-existing WebGL internal format '"+I+"'")}let se;k&&(se=e.get("EXT_texture_norm16"),se||Ae("WebGLRenderer: Unable to use normalized textures without EXT_texture_norm16 extension"));let q=g;if(g===t.RED&&(U===t.FLOAT&&(q=t.R32F),U===t.HALF_FLOAT&&(q=t.R16F),U===t.UNSIGNED_BYTE&&(q=t.R8),U===t.UNSIGNED_SHORT&&se&&(q=se.R16_EXT),U===t.SHORT&&se&&(q=se.R16_SNORM_EXT)),g===t.RED_INTEGER&&(U===t.UNSIGNED_BYTE&&(q=t.R8UI),U===t.UNSIGNED_SHORT&&(q=t.R16UI),U===t.UNSIGNED_INT&&(q=t.R32UI),U===t.BYTE&&(q=t.R8I),U===t.SHORT&&(q=t.R16I),U===t.INT&&(q=t.R32I)),g===t.RG&&(U===t.FLOAT&&(q=t.RG32F),U===t.HALF_FLOAT&&(q=t.RG16F),U===t.UNSIGNED_BYTE&&(q=t.RG8),U===t.UNSIGNED_SHORT&&se&&(q=se.RG16_EXT),U===t.SHORT&&se&&(q=se.RG16_SNORM_EXT)),g===t.RG_INTEGER&&(U===t.UNSIGNED_BYTE&&(q=t.RG8UI),U===t.UNSIGNED_SHORT&&(q=t.RG16UI),U===t.UNSIGNED_INT&&(q=t.RG32UI),U===t.BYTE&&(q=t.RG8I),U===t.SHORT&&(q=t.RG16I),U===t.INT&&(q=t.RG32I)),g===t.RGB_INTEGER&&(U===t.UNSIGNED_BYTE&&(q=t.RGB8UI),U===t.UNSIGNED_SHORT&&(q=t.RGB16UI),U===t.UNSIGNED_INT&&(q=t.RGB32UI),U===t.BYTE&&(q=t.RGB8I),U===t.SHORT&&(q=t.RGB16I),U===t.INT&&(q=t.RGB32I)),g===t.RGBA_INTEGER&&(U===t.UNSIGNED_BYTE&&(q=t.RGBA8UI),U===t.UNSIGNED_SHORT&&(q=t.RGBA16UI),U===t.UNSIGNED_INT&&(q=t.RGBA32UI),U===t.BYTE&&(q=t.RGBA8I),U===t.SHORT&&(q=t.RGBA16I),U===t.INT&&(q=t.RGBA32I)),g===t.RGB&&(U===t.UNSIGNED_SHORT&&se&&(q=se.RGB16_EXT),U===t.SHORT&&se&&(q=se.RGB16_SNORM_EXT),U===t.UNSIGNED_INT_5_9_9_9_REV&&(q=t.RGB9_E5),U===t.UNSIGNED_INT_10F_11F_11F_REV&&(q=t.R11F_G11F_B10F)),g===t.RGBA){let Z=ae?Po:Ge.getTransfer(G);U===t.FLOAT&&(q=t.RGBA32F),U===t.HALF_FLOAT&&(q=t.RGBA16F),U===t.UNSIGNED_BYTE&&(q=Z===at?t.SRGB8_ALPHA8:t.RGBA8),U===t.UNSIGNED_SHORT&&se&&(q=se.RGBA16_EXT),U===t.SHORT&&se&&(q=se.RGBA16_SNORM_EXT),U===t.UNSIGNED_SHORT_4_4_4_4&&(q=t.RGBA4),U===t.UNSIGNED_SHORT_5_5_5_1&&(q=t.RGB5_A1)}return(q===t.R16F||q===t.R32F||q===t.RG16F||q===t.RG32F||q===t.RGBA16F||q===t.RGBA32F)&&e.get("EXT_color_buffer_float"),q}function L(I,g){let U;return I?g===null||g===yn||g===Ir?U=t.DEPTH24_STENCIL8:g===_n?U=t.DEPTH32F_STENCIL8:g===Tr&&(U=t.DEPTH24_STENCIL8,Ae("DepthTexture: 16 bit depth attachment is not supported with stencil. Using 24-bit attachment.")):g===null||g===yn||g===Ir?U=t.DEPTH_COMPONENT24:g===_n?U=t.DEPTH_COMPONENT32F:g===Tr&&(U=t.DEPTH_COMPONENT16),U}function C(I,g){return f(I)===!0||I.isFramebufferTexture&&I.minFilter!==$t&&I.minFilter!==ia?Math.log2(Math.max(g.width,g.height))+1:I.mipmaps!==void 0&&I.mipmaps.length>0?I.mipmaps.length:I.isCompressedTexture&&Array.isArray(I.image)?g.mipmaps.length:1}function T(I){let g=I.target;g.removeEventListener("dispose",T),A(g),g.isVideoTexture&&d.delete(g),g.isHTMLTexture&&p.delete(g)}function y(I){let g=I.target;g.removeEventListener("dispose",y),w(g)}function A(I){let g=n.get(I);if(g.__webglInit===void 0)return;let U=I.source,k=h.get(U);if(k){let G=k[g.__cacheKey];G.usedTimes--,G.usedTimes===0&&E(I),Object.keys(k).length===0&&h.delete(U)}n.remove(I)}function E(I){let g=n.get(I);t.deleteTexture(g.__webglTexture);let U=I.source,k=h.get(U);delete k[g.__cacheKey],r.memory.textures--}function w(I){let g=n.get(I);if(I.depthTexture&&(I.depthTexture.dispose(),n.remove(I.depthTexture)),I.isWebGLCubeRenderTarget)for(let k=0;k<6;k++){if(Array.isArray(g.__webglFramebuffer[k]))for(let G=0;G<g.__webglFramebuffer[k].length;G++)t.deleteFramebuffer(g.__webglFramebuffer[k][G]);else t.deleteFramebuffer(g.__webglFramebuffer[k]);g.__webglDepthbuffer&&t.deleteRenderbuffer(g.__webglDepthbuffer[k])}else{if(Array.isArray(g.__webglFramebuffer))for(let k=0;k<g.__webglFramebuffer.length;k++)t.deleteFramebuffer(g.__webglFramebuffer[k]);else t.deleteFramebuffer(g.__webglFramebuffer);if(g.__webglDepthbuffer&&t.deleteRenderbuffer(g.__webglDepthbuffer),g.__webglMultisampledFramebuffer&&t.deleteFramebuffer(g.__webglMultisampledFramebuffer),g.__webglColorRenderbuffer)for(let k=0;k<g.__webglColorRenderbuffer.length;k++)g.__webglColorRenderbuffer[k]&&t.deleteRenderbuffer(g.__webglColorRenderbuffer[k]);g.__webglDepthRenderbuffer&&t.deleteRenderbuffer(g.__webglDepthRenderbuffer)}let U=I.textures;for(let k=0,G=U.length;k<G;k++){let ae=n.get(U[k]);ae.__webglTexture&&(t.deleteTexture(ae.__webglTexture),r.memory.textures--),n.remove(U[k])}n.remove(I)}let B=0;function X(){B=0}function K(){return B}function z(I){B=I}function W(){let I=B;return I>=i.maxTextures&&Ae("WebGLTextures: Trying to use "+I+" texture units while this GPU supports only "+i.maxTextures),B+=1,I}function V(I){let g=[];return g.push(I.wrapS),g.push(I.wrapT),g.push(I.wrapR||0),g.push(I.magFilter),g.push(I.minFilter),g.push(I.anisotropy),g.push(I.internalFormat),g.push(I.format),g.push(I.type),g.push(I.generateMipmaps),g.push(I.premultiplyAlpha),g.push(I.flipY),g.push(I.unpackAlignment),g.push(I.colorSpace),g.join()}function j(I,g){let U=n.get(I);if(I.isVideoTexture&&D(I),I.isRenderTargetTexture===!1&&I.isExternalTexture!==!0&&I.version>0&&U.__version!==I.version){let k=I.image;if(k===null)Ae("WebGLRenderer: Texture marked for update but no image data found.");else if(k.complete===!1)Ae("WebGLRenderer: Texture marked for update but image is incomplete");else{Re(U,I,g);return}}else I.isExternalTexture&&(U.__webglTexture=I.sourceTexture?I.sourceTexture:null);a.bindTexture(t.TEXTURE_2D,U.__webglTexture,t.TEXTURE0+g)}function ee(I,g){let U=n.get(I);if(I.isRenderTargetTexture===!1&&I.version>0&&U.__version!==I.version){Re(U,I,g);return}else I.isExternalTexture&&(U.__webglTexture=I.sourceTexture?I.sourceTexture:null);a.bindTexture(t.TEXTURE_2D_ARRAY,U.__webglTexture,t.TEXTURE0+g)}function fe(I,g){let U=n.get(I);if(I.isRenderTargetTexture===!1&&I.version>0&&U.__version!==I.version){Re(U,I,g);return}a.bindTexture(t.TEXTURE_3D,U.__webglTexture,t.TEXTURE0+g)}function me(I,g){let U=n.get(I);if(I.isCubeDepthTexture!==!0&&I.version>0&&U.__version!==I.version){Ue(U,I,g);return}a.bindTexture(t.TEXTURE_CUBE_MAP,U.__webglTexture,t.TEXTURE0+g)}let ve={[Wu]:t.REPEAT,[Rn]:t.CLAMP_TO_EDGE,[Xu]:t.MIRRORED_REPEAT},Qe={[$t]:t.NEAREST,[h0]:t.NEAREST_MIPMAP_NEAREST,[Qo]:t.NEAREST_MIPMAP_LINEAR,[ia]:t.LINEAR,[vc]:t.LINEAR_MIPMAP_NEAREST,[qi]:t.LINEAR_MIPMAP_LINEAR},Tt={[g0]:t.NEVER,[S0]:t.ALWAYS,[x0]:t.LESS,[tf]:t.LEQUAL,[v0]:t.EQUAL,[af]:t.GEQUAL,[y0]:t.GREATER,[_0]:t.NOTEQUAL};function je(I,g){if(g.type===_n&&e.has("OES_texture_float_linear")===!1&&(g.magFilter===ia||g.magFilter===vc||g.magFilter===Qo||g.magFilter===qi||g.minFilter===ia||g.minFilter===vc||g.minFilter===Qo||g.minFilter===qi)&&Ae("WebGLRenderer: Unable to use linear filtering with floating point textures. OES_texture_float_linear not supported on this device."),t.texParameteri(I,t.TEXTURE_WRAP_S,ve[g.wrapS]),t.texParameteri(I,t.TEXTURE_WRAP_T,ve[g.wrapT]),(I===t.TEXTURE_3D||I===t.TEXTURE_2D_ARRAY)&&t.texParameteri(I,t.TEXTURE_WRAP_R,ve[g.wrapR]),t.texParameteri(I,t.TEXTURE_MAG_FILTER,Qe[g.magFilter]),t.texParameteri(I,t.TEXTURE_MIN_FILTER,Qe[g.minFilter]),g.compareFunction&&(t.texParameteri(I,t.TEXTURE_COMPARE_MODE,t.COMPARE_REF_TO_TEXTURE),t.texParameteri(I,t.TEXTURE_COMPARE_FUNC,Tt[g.compareFunction])),e.has("EXT_texture_filter_anisotropic")===!0){if(g.magFilter===$t||g.minFilter!==Qo&&g.minFilter!==qi||g.type===_n&&e.has("OES_texture_float_linear")===!1)return;if(g.anisotropy>1||n.get(g).__currentAnisotropy){let U=e.get("EXT_texture_filter_anisotropic");t.texParameterf(I,U.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(g.anisotropy,i.getMaxAnisotropy())),n.get(g).__currentAnisotropy=g.anisotropy}}}function J(I,g){let U=!1;I.__webglInit===void 0&&(I.__webglInit=!0,g.addEventListener("dispose",T));let k=g.source,G=h.get(k);G===void 0&&(G={},h.set(k,G));let ae=V(g);if(ae!==I.__cacheKey){G[ae]===void 0&&(G[ae]={texture:t.createTexture(),usedTimes:0},r.memory.textures++,U=!0),G[ae].usedTimes++;let se=G[I.__cacheKey];se!==void 0&&(G[I.__cacheKey].usedTimes--,se.usedTimes===0&&E(g)),I.__cacheKey=ae,I.__webglTexture=G[ae].texture}return U}function ie(I,g,U){return Math.floor(Math.floor(I/U)/g)}function te(I,g,U,k){let ae=I.updateRanges;if(ae.length===0)a.texSubImage2D(t.TEXTURE_2D,0,0,0,g.width,g.height,U,k,g.data);else{ae.sort((Me,ue)=>Me.start-ue.start);let se=0;for(let Me=1;Me<ae.length;Me++){let ue=ae[se],oe=ae[Me],Le=ue.start+ue.count,Ie=ie(oe.start,g.width,4),Be=ie(ue.start,g.width,4);oe.start<=Le+1&&Ie===Be&&ie(oe.start+oe.count-1,g.width,4)===Ie?ue.count=Math.max(ue.count,oe.start+oe.count-ue.start):(++se,ae[se]=oe)}ae.length=se+1;let q=a.getParameter(t.UNPACK_ROW_LENGTH),Z=a.getParameter(t.UNPACK_SKIP_PIXELS),re=a.getParameter(t.UNPACK_SKIP_ROWS);a.pixelStorei(t.UNPACK_ROW_LENGTH,g.width);for(let Me=0,ue=ae.length;Me<ue;Me++){let oe=ae[Me],Le=Math.floor(oe.start/4),Ie=Math.ceil(oe.count/4),Be=Le%g.width,R=Math.floor(Le/g.width),ne=Ie,Y=1;a.pixelStorei(t.UNPACK_SKIP_PIXELS,Be),a.pixelStorei(t.UNPACK_SKIP_ROWS,R),a.texSubImage2D(t.TEXTURE_2D,0,Be,R,ne,Y,U,k,g.data)}I.clearUpdateRanges(),a.pixelStorei(t.UNPACK_ROW_LENGTH,q),a.pixelStorei(t.UNPACK_SKIP_PIXELS,Z),a.pixelStorei(t.UNPACK_SKIP_ROWS,re)}}function Re(I,g,U){let k=t.TEXTURE_2D;(g.isDataArrayTexture||g.isCompressedArrayTexture)&&(k=t.TEXTURE_2D_ARRAY),g.isData3DTexture&&(k=t.TEXTURE_3D);let G=J(I,g),ae=g.source;a.bindTexture(k,I.__webglTexture,t.TEXTURE0+U);let se=n.get(ae);if(ae.version!==se.__version||G===!0){if(a.activeTexture(t.TEXTURE0+U),(typeof ImageBitmap<"u"&&g.image instanceof ImageBitmap)===!1){let Y=Ge.getPrimaries(Ge.workingColorSpace),le=g.colorSpace===ii?null:Ge.getPrimaries(g.colorSpace),pe=g.colorSpace===ii||Y===le?t.NONE:t.BROWSER_DEFAULT_WEBGL;a.pixelStorei(t.UNPACK_FLIP_Y_WEBGL,g.flipY),a.pixelStorei(t.UNPACK_PREMULTIPLY_ALPHA_WEBGL,g.premultiplyAlpha),a.pixelStorei(t.UNPACK_COLORSPACE_CONVERSION_WEBGL,pe)}a.pixelStorei(t.UNPACK_ALIGNMENT,g.unpackAlignment);let Z=m(g.image,!1,i.maxTextureSize);Z=Ma(g,Z);let re=s.convert(g.format,g.colorSpace),Me=s.convert(g.type),ue=_(g.internalFormat,re,Me,g.normalized,g.colorSpace,g.isVideoTexture);je(k,g);let oe,Le=g.mipmaps,Ie=g.isVideoTexture!==!0,Be=se.__version===void 0||G===!0,R=ae.dataReady,ne=C(g,Z);if(g.isDepthTexture)ue=L(g.format===Wi,g.type),Be&&(Ie?a.texStorage2D(t.TEXTURE_2D,1,ue,Z.width,Z.height):a.texImage2D(t.TEXTURE_2D,0,ue,Z.width,Z.height,0,re,Me,null));else if(g.isDataTexture)if(Le.length>0){Ie&&Be&&a.texStorage2D(t.TEXTURE_2D,ne,ue,Le[0].width,Le[0].height);for(let Y=0,le=Le.length;Y<le;Y++)oe=Le[Y],Ie?R&&a.texSubImage2D(t.TEXTURE_2D,Y,0,0,oe.width,oe.height,re,Me,oe.data):a.texImage2D(t.TEXTURE_2D,Y,ue,oe.width,oe.height,0,re,Me,oe.data);g.generateMipmaps=!1}else Ie?(Be&&a.texStorage2D(t.TEXTURE_2D,ne,ue,Z.width,Z.height),R&&te(g,Z,re,Me)):a.texImage2D(t.TEXTURE_2D,0,ue,Z.width,Z.height,0,re,Me,Z.data);else if(g.isCompressedTexture)if(g.isCompressedArrayTexture){Ie&&Be&&a.texStorage3D(t.TEXTURE_2D_ARRAY,ne,ue,Le[0].width,Le[0].height,Z.depth);for(let Y=0,le=Le.length;Y<le;Y++)if(oe=Le[Y],g.format!==tn)if(re!==null)if(Ie){if(R)if(g.layerUpdates.size>0){let pe=np(oe.width,oe.height,g.format,g.type);for(let $ of g.layerUpdates){let Se=oe.data.subarray($*pe/oe.data.BYTES_PER_ELEMENT,($+1)*pe/oe.data.BYTES_PER_ELEMENT);a.compressedTexSubImage3D(t.TEXTURE_2D_ARRAY,Y,0,0,$,oe.width,oe.height,1,re,Se)}g.clearLayerUpdates()}else a.compressedTexSubImage3D(t.TEXTURE_2D_ARRAY,Y,0,0,0,oe.width,oe.height,Z.depth,re,oe.data)}else a.compressedTexImage3D(t.TEXTURE_2D_ARRAY,Y,ue,oe.width,oe.height,Z.depth,0,oe.data,0,0);else Ae("WebGLRenderer: Attempt to load unsupported compressed texture format in .uploadTexture()");else Ie?R&&a.texSubImage3D(t.TEXTURE_2D_ARRAY,Y,0,0,0,oe.width,oe.height,Z.depth,re,Me,oe.data):a.texImage3D(t.TEXTURE_2D_ARRAY,Y,ue,oe.width,oe.height,Z.depth,0,re,Me,oe.data)}else{Ie&&Be&&a.texStorage2D(t.TEXTURE_2D,ne,ue,Le[0].width,Le[0].height);for(let Y=0,le=Le.length;Y<le;Y++)oe=Le[Y],g.format!==tn?re!==null?Ie?R&&a.compressedTexSubImage2D(t.TEXTURE_2D,Y,0,0,oe.width,oe.height,re,oe.data):a.compressedTexImage2D(t.TEXTURE_2D,Y,ue,oe.width,oe.height,0,oe.data):Ae("WebGLRenderer: Attempt to load unsupported compressed texture format in .uploadTexture()"):Ie?R&&a.texSubImage2D(t.TEXTURE_2D,Y,0,0,oe.width,oe.height,re,Me,oe.data):a.texImage2D(t.TEXTURE_2D,Y,ue,oe.width,oe.height,0,re,Me,oe.data)}else if(g.isDataArrayTexture)if(Ie){if(Be&&a.texStorage3D(t.TEXTURE_2D_ARRAY,ne,ue,Z.width,Z.height,Z.depth),R)if(g.layerUpdates.size>0){let Y=np(Z.width,Z.height,g.format,g.type);for(let le of g.layerUpdates){let pe=Z.data.subarray(le*Y/Z.data.BYTES_PER_ELEMENT,(le+1)*Y/Z.data.BYTES_PER_ELEMENT);a.texSubImage3D(t.TEXTURE_2D_ARRAY,0,0,0,le,Z.width,Z.height,1,re,Me,pe)}g.clearLayerUpdates()}else a.texSubImage3D(t.TEXTURE_2D_ARRAY,0,0,0,0,Z.width,Z.height,Z.depth,re,Me,Z.data)}else a.texImage3D(t.TEXTURE_2D_ARRAY,0,ue,Z.width,Z.height,Z.depth,0,re,Me,Z.data);else if(g.isData3DTexture)Ie?(Be&&a.texStorage3D(t.TEXTURE_3D,ne,ue,Z.width,Z.height,Z.depth),R&&a.texSubImage3D(t.TEXTURE_3D,0,0,0,0,Z.width,Z.height,Z.depth,re,Me,Z.data)):a.texImage3D(t.TEXTURE_3D,0,ue,Z.width,Z.height,Z.depth,0,re,Me,Z.data);else if(g.isFramebufferTexture){if(Be)if(Ie)a.texStorage2D(t.TEXTURE_2D,ne,ue,Z.width,Z.height);else{let Y=Z.width,le=Z.height;for(let pe=0;pe<ne;pe++)a.texImage2D(t.TEXTURE_2D,pe,ue,Y,le,0,re,Me,null),Y>>=1,le>>=1}}else if(g.isHTMLTexture){if("texElementImage2D"in t){let Y=t.canvas;if(Y.hasAttribute("layoutsubtree")||Y.setAttribute("layoutsubtree","true"),Z.parentNode!==Y){Y.appendChild(Z),p.add(g),Y.onpaint=le=>{let pe=le.changedElements;for(let $ of p)pe.includes($.image)&&($.needsUpdate=!0)},Y.requestPaint();return}if(t.texElementImage2D.length===3)t.texElementImage2D(t.TEXTURE_2D,t.RGBA8,Z);else{let pe=t.RGBA,$=t.RGBA,Se=t.UNSIGNED_BYTE;t.texElementImage2D(t.TEXTURE_2D,0,pe,$,Se,Z)}t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE)}}else if(Le.length>0){if(Ie&&Be){let Y=nt(Le[0]);a.texStorage2D(t.TEXTURE_2D,ne,ue,Y.width,Y.height)}for(let Y=0,le=Le.length;Y<le;Y++)oe=Le[Y],Ie?R&&a.texSubImage2D(t.TEXTURE_2D,Y,0,0,re,Me,oe):a.texImage2D(t.TEXTURE_2D,Y,ue,re,Me,oe);g.generateMipmaps=!1}else if(Ie){if(Be){let Y=nt(Z);a.texStorage2D(t.TEXTURE_2D,ne,ue,Y.width,Y.height)}R&&a.texSubImage2D(t.TEXTURE_2D,0,0,0,re,Me,Z)}else a.texImage2D(t.TEXTURE_2D,0,ue,re,Me,Z);f(g)&&x(k),se.__version=ae.version,g.onUpdate&&g.onUpdate(g)}I.__version=g.version}function Ue(I,g,U){if(g.image.length!==6)return;let k=J(I,g),G=g.source;a.bindTexture(t.TEXTURE_CUBE_MAP,I.__webglTexture,t.TEXTURE0+U);let ae=n.get(G);if(G.version!==ae.__version||k===!0){a.activeTexture(t.TEXTURE0+U);let se=Ge.getPrimaries(Ge.workingColorSpace),q=g.colorSpace===ii?null:Ge.getPrimaries(g.colorSpace),Z=g.colorSpace===ii||se===q?t.NONE:t.BROWSER_DEFAULT_WEBGL;a.pixelStorei(t.UNPACK_FLIP_Y_WEBGL,g.flipY),a.pixelStorei(t.UNPACK_PREMULTIPLY_ALPHA_WEBGL,g.premultiplyAlpha),a.pixelStorei(t.UNPACK_ALIGNMENT,g.unpackAlignment),a.pixelStorei(t.UNPACK_COLORSPACE_CONVERSION_WEBGL,Z);let re=g.isCompressedTexture||g.image[0].isCompressedTexture,Me=g.image[0]&&g.image[0].isDataTexture,ue=[];for(let $=0;$<6;$++)!re&&!Me?ue[$]=m(g.image[$],!0,i.maxCubemapSize):ue[$]=Me?g.image[$].image:g.image[$],ue[$]=Ma(g,ue[$]);let oe=ue[0],Le=s.convert(g.format,g.colorSpace),Ie=s.convert(g.type),Be=_(g.internalFormat,Le,Ie,g.normalized,g.colorSpace),R=g.isVideoTexture!==!0,ne=ae.__version===void 0||k===!0,Y=G.dataReady,le=C(g,oe);je(t.TEXTURE_CUBE_MAP,g);let pe;if(re){R&&ne&&a.texStorage2D(t.TEXTURE_CUBE_MAP,le,Be,oe.width,oe.height);for(let $=0;$<6;$++){pe=ue[$].mipmaps;for(let Se=0;Se<pe.length;Se++){let ye=pe[Se];g.format!==tn?Le!==null?R?Y&&a.compressedTexSubImage2D(t.TEXTURE_CUBE_MAP_POSITIVE_X+$,Se,0,0,ye.width,ye.height,Le,ye.data):a.compressedTexImage2D(t.TEXTURE_CUBE_MAP_POSITIVE_X+$,Se,Be,ye.width,ye.height,0,ye.data):Ae("WebGLRenderer: Attempt to load unsupported compressed texture format in .setTextureCube()"):R?Y&&a.texSubImage2D(t.TEXTURE_CUBE_MAP_POSITIVE_X+$,Se,0,0,ye.width,ye.height,Le,Ie,ye.data):a.texImage2D(t.TEXTURE_CUBE_MAP_POSITIVE_X+$,Se,Be,ye.width,ye.height,0,Le,Ie,ye.data)}}}else{if(pe=g.mipmaps,R&&ne){pe.length>0&&le++;let $=nt(ue[0]);a.texStorage2D(t.TEXTURE_CUBE_MAP,le,Be,$.width,$.height)}for(let $=0;$<6;$++)if(Me){R?Y&&a.texSubImage2D(t.TEXTURE_CUBE_MAP_POSITIVE_X+$,0,0,0,ue[$].width,ue[$].height,Le,Ie,ue[$].data):a.texImage2D(t.TEXTURE_CUBE_MAP_POSITIVE_X+$,0,Be,ue[$].width,ue[$].height,0,Le,Ie,ue[$].data);for(let Se=0;Se<pe.length;Se++){let Et=pe[Se].image[$].image;R?Y&&a.texSubImage2D(t.TEXTURE_CUBE_MAP_POSITIVE_X+$,Se+1,0,0,Et.width,Et.height,Le,Ie,Et.data):a.texImage2D(t.TEXTURE_CUBE_MAP_POSITIVE_X+$,Se+1,Be,Et.width,Et.height,0,Le,Ie,Et.data)}}else{R?Y&&a.texSubImage2D(t.TEXTURE_CUBE_MAP_POSITIVE_X+$,0,0,0,Le,Ie,ue[$]):a.texImage2D(t.TEXTURE_CUBE_MAP_POSITIVE_X+$,0,Be,Le,Ie,ue[$]);for(let Se=0;Se<pe.length;Se++){let ye=pe[Se];R?Y&&a.texSubImage2D(t.TEXTURE_CUBE_MAP_POSITIVE_X+$,Se+1,0,0,Le,Ie,ye.image[$]):a.texImage2D(t.TEXTURE_CUBE_MAP_POSITIVE_X+$,Se+1,Be,Le,Ie,ye.image[$])}}}f(g)&&x(t.TEXTURE_CUBE_MAP),ae.__version=G.version,g.onUpdate&&g.onUpdate(g)}I.__version=g.version}function Te(I,g,U,k,G,ae){let se=s.convert(U.format,U.colorSpace),q=s.convert(U.type),Z=_(U.internalFormat,se,q,U.normalized,U.colorSpace),re=n.get(g),Me=n.get(U);if(Me.__renderTarget=g,!re.__hasExternalTextures){let ue=Math.max(1,g.width>>ae),oe=Math.max(1,g.height>>ae);G===t.TEXTURE_3D||G===t.TEXTURE_2D_ARRAY?a.texImage3D(G,ae,Z,ue,oe,g.depth,0,se,q,null):a.texImage2D(G,ae,Z,ue,oe,0,se,q,null)}a.bindFramebuffer(t.FRAMEBUFFER,I),kt(g)?o.framebufferTexture2DMultisampleEXT(t.FRAMEBUFFER,k,G,Me.__webglTexture,0,It(g)):(G===t.TEXTURE_2D||G>=t.TEXTURE_CUBE_MAP_POSITIVE_X&&G<=t.TEXTURE_CUBE_MAP_NEGATIVE_Z)&&t.framebufferTexture2D(t.FRAMEBUFFER,k,G,Me.__webglTexture,ae),a.bindFramebuffer(t.FRAMEBUFFER,null)}function Pt(I,g,U){if(t.bindRenderbuffer(t.RENDERBUFFER,I),g.depthBuffer){let k=g.depthTexture,G=k&&k.isDepthTexture?k.type:null,ae=L(g.stencilBuffer,G),se=g.stencilBuffer?t.DEPTH_STENCIL_ATTACHMENT:t.DEPTH_ATTACHMENT;kt(g)?o.renderbufferStorageMultisampleEXT(t.RENDERBUFFER,It(g),ae,g.width,g.height):U?t.renderbufferStorageMultisample(t.RENDERBUFFER,It(g),ae,g.width,g.height):t.renderbufferStorage(t.RENDERBUFFER,ae,g.width,g.height),t.framebufferRenderbuffer(t.FRAMEBUFFER,se,t.RENDERBUFFER,I)}else{let k=g.textures;for(let G=0;G<k.length;G++){let ae=k[G],se=s.convert(ae.format,ae.colorSpace),q=s.convert(ae.type),Z=_(ae.internalFormat,se,q,ae.normalized,ae.colorSpace);kt(g)?o.renderbufferStorageMultisampleEXT(t.RENDERBUFFER,It(g),Z,g.width,g.height):U?t.renderbufferStorageMultisample(t.RENDERBUFFER,It(g),Z,g.width,g.height):t.renderbufferStorage(t.RENDERBUFFER,Z,g.width,g.height)}}t.bindRenderbuffer(t.RENDERBUFFER,null)}function Ve(I,g,U){let k=g.isWebGLCubeRenderTarget===!0;if(a.bindFramebuffer(t.FRAMEBUFFER,I),!(g.depthTexture&&g.depthTexture.isDepthTexture))throw new Error("THREE.WebGLTextures: renderTarget.depthTexture must be an instance of THREE.DepthTexture.");let G=n.get(g.depthTexture);if(G.__renderTarget=g,(!G.__webglTexture||g.depthTexture.image.width!==g.width||g.depthTexture.image.height!==g.height)&&(g.depthTexture.image.width=g.width,g.depthTexture.image.height=g.height,g.depthTexture.needsUpdate=!0),k){if(G.__webglInit===void 0&&(G.__webglInit=!0,g.depthTexture.addEventListener("dispose",T)),G.__webglTexture===void 0){G.__webglTexture=t.createTexture(),a.bindTexture(t.TEXTURE_CUBE_MAP,G.__webglTexture),je(t.TEXTURE_CUBE_MAP,g.depthTexture);let re=s.convert(g.depthTexture.format),Me=s.convert(g.depthTexture.type),ue;g.depthTexture.format===Dn?ue=t.DEPTH_COMPONENT24:g.depthTexture.format===Wi&&(ue=t.DEPTH24_STENCIL8);for(let oe=0;oe<6;oe++)t.texImage2D(t.TEXTURE_CUBE_MAP_POSITIVE_X+oe,0,ue,g.width,g.height,0,re,Me,null)}}else j(g.depthTexture,0);let ae=G.__webglTexture,se=It(g),q=k?t.TEXTURE_CUBE_MAP_POSITIVE_X+U:t.TEXTURE_2D,Z=g.depthTexture.format===Wi?t.DEPTH_STENCIL_ATTACHMENT:t.DEPTH_ATTACHMENT;if(g.depthTexture.format===Dn)kt(g)?o.framebufferTexture2DMultisampleEXT(t.FRAMEBUFFER,Z,q,ae,0,se):t.framebufferTexture2D(t.FRAMEBUFFER,Z,q,ae,0);else if(g.depthTexture.format===Wi)kt(g)?o.framebufferTexture2DMultisampleEXT(t.FRAMEBUFFER,Z,q,ae,0,se):t.framebufferTexture2D(t.FRAMEBUFFER,Z,q,ae,0);else throw new Error("THREE.WebGLTextures: Unknown depthTexture format.")}function ut(I){let g=n.get(I),U=I.isWebGLCubeRenderTarget===!0;if(g.__boundDepthTexture!==I.depthTexture){let k=I.depthTexture;if(g.__depthDisposeCallback&&g.__depthDisposeCallback(),k){let G=()=>{delete g.__boundDepthTexture,delete g.__depthDisposeCallback,k.removeEventListener("dispose",G)};k.addEventListener("dispose",G),g.__depthDisposeCallback=G}g.__boundDepthTexture=k}if(I.depthTexture&&!g.__autoAllocateDepthBuffer)if(U)for(let k=0;k<6;k++)Ve(g.__webglFramebuffer[k],I,k);else{let k=I.texture.mipmaps;k&&k.length>0?Ve(g.__webglFramebuffer[0],I,0):Ve(g.__webglFramebuffer,I,0)}else if(U){g.__webglDepthbuffer=[];for(let k=0;k<6;k++)if(a.bindFramebuffer(t.FRAMEBUFFER,g.__webglFramebuffer[k]),g.__webglDepthbuffer[k]===void 0)g.__webglDepthbuffer[k]=t.createRenderbuffer(),Pt(g.__webglDepthbuffer[k],I,!1);else{let G=I.stencilBuffer?t.DEPTH_STENCIL_ATTACHMENT:t.DEPTH_ATTACHMENT,ae=g.__webglDepthbuffer[k];t.bindRenderbuffer(t.RENDERBUFFER,ae),t.framebufferRenderbuffer(t.FRAMEBUFFER,G,t.RENDERBUFFER,ae)}}else{let k=I.texture.mipmaps;if(k&&k.length>0?a.bindFramebuffer(t.FRAMEBUFFER,g.__webglFramebuffer[0]):a.bindFramebuffer(t.FRAMEBUFFER,g.__webglFramebuffer),g.__webglDepthbuffer===void 0)g.__webglDepthbuffer=t.createRenderbuffer(),Pt(g.__webglDepthbuffer,I,!1);else{let G=I.stencilBuffer?t.DEPTH_STENCIL_ATTACHMENT:t.DEPTH_ATTACHMENT,ae=g.__webglDepthbuffer;t.bindRenderbuffer(t.RENDERBUFFER,ae),t.framebufferRenderbuffer(t.FRAMEBUFFER,G,t.RENDERBUFFER,ae)}}a.bindFramebuffer(t.FRAMEBUFFER,null)}function $e(I,g,U){let k=n.get(I);g!==void 0&&Te(k.__webglFramebuffer,I,I.texture,t.COLOR_ATTACHMENT0,t.TEXTURE_2D,0),U!==void 0&&ut(I)}function Ze(I){let g=I.texture,U=n.get(I),k=n.get(g);I.addEventListener("dispose",y);let G=I.textures,ae=I.isWebGLCubeRenderTarget===!0,se=G.length>1;if(se||(k.__webglTexture===void 0&&(k.__webglTexture=t.createTexture()),k.__version=g.version,r.memory.textures++),ae){U.__webglFramebuffer=[];for(let q=0;q<6;q++)if(g.mipmaps&&g.mipmaps.length>0){U.__webglFramebuffer[q]=[];for(let Z=0;Z<g.mipmaps.length;Z++)U.__webglFramebuffer[q][Z]=t.createFramebuffer()}else U.__webglFramebuffer[q]=t.createFramebuffer()}else{if(g.mipmaps&&g.mipmaps.length>0){U.__webglFramebuffer=[];for(let q=0;q<g.mipmaps.length;q++)U.__webglFramebuffer[q]=t.createFramebuffer()}else U.__webglFramebuffer=t.createFramebuffer();if(se)for(let q=0,Z=G.length;q<Z;q++){let re=n.get(G[q]);re.__webglTexture===void 0&&(re.__webglTexture=t.createTexture(),r.memory.textures++)}if(I.samples>0&&kt(I)===!1){U.__webglMultisampledFramebuffer=t.createFramebuffer(),U.__webglColorRenderbuffer=[],a.bindFramebuffer(t.FRAMEBUFFER,U.__webglMultisampledFramebuffer);for(let q=0;q<G.length;q++){let Z=G[q];U.__webglColorRenderbuffer[q]=t.createRenderbuffer(),t.bindRenderbuffer(t.RENDERBUFFER,U.__webglColorRenderbuffer[q]);let re=s.convert(Z.format,Z.colorSpace),Me=s.convert(Z.type),ue=_(Z.internalFormat,re,Me,Z.normalized,Z.colorSpace,I.isXRRenderTarget===!0),oe=It(I);t.renderbufferStorageMultisample(t.RENDERBUFFER,oe,ue,I.width,I.height),t.framebufferRenderbuffer(t.FRAMEBUFFER,t.COLOR_ATTACHMENT0+q,t.RENDERBUFFER,U.__webglColorRenderbuffer[q])}t.bindRenderbuffer(t.RENDERBUFFER,null),I.depthBuffer&&(U.__webglDepthRenderbuffer=t.createRenderbuffer(),Pt(U.__webglDepthRenderbuffer,I,!0)),a.bindFramebuffer(t.FRAMEBUFFER,null)}}if(ae){a.bindTexture(t.TEXTURE_CUBE_MAP,k.__webglTexture),je(t.TEXTURE_CUBE_MAP,g);for(let q=0;q<6;q++)if(g.mipmaps&&g.mipmaps.length>0)for(let Z=0;Z<g.mipmaps.length;Z++)Te(U.__webglFramebuffer[q][Z],I,g,t.COLOR_ATTACHMENT0,t.TEXTURE_CUBE_MAP_POSITIVE_X+q,Z);else Te(U.__webglFramebuffer[q],I,g,t.COLOR_ATTACHMENT0,t.TEXTURE_CUBE_MAP_POSITIVE_X+q,0);f(g)&&x(t.TEXTURE_CUBE_MAP),a.unbindTexture()}else if(se){for(let q=0,Z=G.length;q<Z;q++){let re=G[q],Me=n.get(re),ue=t.TEXTURE_2D;(I.isWebGL3DRenderTarget||I.isWebGLArrayRenderTarget)&&(ue=I.isWebGL3DRenderTarget?t.TEXTURE_3D:t.TEXTURE_2D_ARRAY),a.bindTexture(ue,Me.__webglTexture),je(ue,re),Te(U.__webglFramebuffer,I,re,t.COLOR_ATTACHMENT0+q,ue,0),f(re)&&x(ue)}a.unbindTexture()}else{let q=t.TEXTURE_2D;if((I.isWebGL3DRenderTarget||I.isWebGLArrayRenderTarget)&&(q=I.isWebGL3DRenderTarget?t.TEXTURE_3D:t.TEXTURE_2D_ARRAY),a.bindTexture(q,k.__webglTexture),je(q,g),g.mipmaps&&g.mipmaps.length>0)for(let Z=0;Z<g.mipmaps.length;Z++)Te(U.__webglFramebuffer[Z],I,g,t.COLOR_ATTACHMENT0,q,Z);else Te(U.__webglFramebuffer,I,g,t.COLOR_ATTACHMENT0,q,0);f(g)&&x(q),a.unbindTexture()}I.depthBuffer&&ut(I)}function zt(I){let g=I.textures;for(let U=0,k=g.length;U<k;U++){let G=g[U];if(f(G)){let ae=S(I),se=n.get(G).__webglTexture;a.bindTexture(ae,se),x(ae),a.unbindTexture()}}}let Xt=[],Qt=[];function na(I){if(I.samples>0){if(kt(I)===!1){let g=I.textures,U=I.width,k=I.height,G=t.COLOR_BUFFER_BIT,ae=I.stencilBuffer?t.DEPTH_STENCIL_ATTACHMENT:t.DEPTH_ATTACHMENT,se=n.get(I),q=g.length>1;if(q)for(let re=0;re<g.length;re++)a.bindFramebuffer(t.FRAMEBUFFER,se.__webglMultisampledFramebuffer),t.framebufferRenderbuffer(t.FRAMEBUFFER,t.COLOR_ATTACHMENT0+re,t.RENDERBUFFER,null),a.bindFramebuffer(t.FRAMEBUFFER,se.__webglFramebuffer),t.framebufferTexture2D(t.DRAW_FRAMEBUFFER,t.COLOR_ATTACHMENT0+re,t.TEXTURE_2D,null,0);a.bindFramebuffer(t.READ_FRAMEBUFFER,se.__webglMultisampledFramebuffer);let Z=I.texture.mipmaps;Z&&Z.length>0?a.bindFramebuffer(t.DRAW_FRAMEBUFFER,se.__webglFramebuffer[0]):a.bindFramebuffer(t.DRAW_FRAMEBUFFER,se.__webglFramebuffer);for(let re=0;re<g.length;re++){if(I.resolveDepthBuffer&&(I.depthBuffer&&(G|=t.DEPTH_BUFFER_BIT),I.stencilBuffer&&I.resolveStencilBuffer&&(G|=t.STENCIL_BUFFER_BIT)),q){t.framebufferRenderbuffer(t.READ_FRAMEBUFFER,t.COLOR_ATTACHMENT0,t.RENDERBUFFER,se.__webglColorRenderbuffer[re]);let Me=n.get(g[re]).__webglTexture;t.framebufferTexture2D(t.DRAW_FRAMEBUFFER,t.COLOR_ATTACHMENT0,t.TEXTURE_2D,Me,0)}t.blitFramebuffer(0,0,U,k,0,0,U,k,G,t.NEAREST),l===!0&&(Xt.length=0,Qt.length=0,Xt.push(t.COLOR_ATTACHMENT0+re),I.depthBuffer&&I.resolveDepthBuffer===!1&&(Xt.push(ae),Qt.push(ae),t.invalidateFramebuffer(t.DRAW_FRAMEBUFFER,Qt)),t.invalidateFramebuffer(t.READ_FRAMEBUFFER,Xt))}if(a.bindFramebuffer(t.READ_FRAMEBUFFER,null),a.bindFramebuffer(t.DRAW_FRAMEBUFFER,null),q)for(let re=0;re<g.length;re++){a.bindFramebuffer(t.FRAMEBUFFER,se.__webglMultisampledFramebuffer),t.framebufferRenderbuffer(t.FRAMEBUFFER,t.COLOR_ATTACHMENT0+re,t.RENDERBUFFER,se.__webglColorRenderbuffer[re]);let Me=n.get(g[re]).__webglTexture;a.bindFramebuffer(t.FRAMEBUFFER,se.__webglFramebuffer),t.framebufferTexture2D(t.DRAW_FRAMEBUFFER,t.COLOR_ATTACHMENT0+re,t.TEXTURE_2D,Me,0)}a.bindFramebuffer(t.DRAW_FRAMEBUFFER,se.__webglMultisampledFramebuffer)}else if(I.depthBuffer&&I.resolveDepthBuffer===!1&&l){let g=I.stencilBuffer?t.DEPTH_STENCIL_ATTACHMENT:t.DEPTH_ATTACHMENT;t.invalidateFramebuffer(t.DRAW_FRAMEBUFFER,[g])}}}function It(I){return Math.min(i.maxSamples,I.samples)}function kt(I){let g=n.get(I);return I.samples>0&&e.has("WEBGL_multisampled_render_to_texture")===!0&&g.__useRenderToTexture!==!1}function D(I){let g=r.render.frame;d.get(I)!==g&&(d.set(I,g),I.update())}function Ma(I,g){let U=I.colorSpace,k=I.format,G=I.type;return I.isCompressedTexture===!0||I.isVideoTexture===!0||U!==Do&&U!==ii&&(Ge.getTransfer(U)===at?(k!==tn||G!==ka)&&Ae("WebGLTextures: sRGB encoded textures have to use RGBAFormat and UnsignedByteType."):Ee("WebGLTextures: Unsupported texture color space:",U)),g}function nt(I){return typeof HTMLImageElement<"u"&&I instanceof HTMLImageElement?(u.width=I.naturalWidth||I.width,u.height=I.naturalHeight||I.height):typeof VideoFrame<"u"&&I instanceof VideoFrame?(u.width=I.displayWidth,u.height=I.displayHeight):(u.width=I.width,u.height=I.height),u}this.allocateTextureUnit=W,this.resetTextureUnits=X,this.getTextureUnits=K,this.setTextureUnits=z,this.setTexture2D=j,this.setTexture2DArray=ee,this.setTexture3D=fe,this.setTextureCube=me,this.rebindTextures=$e,this.setupRenderTarget=Ze,this.updateRenderTargetMipmap=zt,this.updateMultisampleRenderTarget=na,this.setupDepthRenderbuffer=ut,this.setupFrameBufferTexture=Te,this.useMultisampledRTT=kt,this.isReversedDepthBuffer=function(){return a.buffers.depth.getReversed()}}function kT(t,e){function a(n,i=ii){let s,r=Ge.getTransfer(i);if(n===ka)return t.UNSIGNED_BYTE;if(n===_c)return t.UNSIGNED_SHORT_4_4_4_4;if(n===Sc)return t.UNSIGNED_SHORT_5_5_5_1;if(n===Xh)return t.UNSIGNED_INT_5_9_9_9_REV;if(n===Yh)return t.UNSIGNED_INT_10F_11F_11F_REV;if(n===qh)return t.BYTE;if(n===Wh)return t.SHORT;if(n===Tr)return t.UNSIGNED_SHORT;if(n===yc)return t.INT;if(n===yn)return t.UNSIGNED_INT;if(n===_n)return t.FLOAT;if(n===Fn)return t.HALF_FLOAT;if(n===Zh)return t.ALPHA;if(n===Kh)return t.RGB;if(n===tn)return t.RGBA;if(n===Dn)return t.DEPTH_COMPONENT;if(n===Wi)return t.DEPTH_STENCIL;if(n===Jh)return t.RED;if(n===Mc)return t.RED_INTEGER;if(n===Xi)return t.RG;if(n===bc)return t.RG_INTEGER;if(n===Cc)return t.RGBA_INTEGER;if(n===jo||n===$o||n===el||n===tl)if(r===at)if(s=e.get("WEBGL_compressed_texture_s3tc_srgb"),s!==null){if(n===jo)return s.COMPRESSED_SRGB_S3TC_DXT1_EXT;if(n===$o)return s.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT;if(n===el)return s.COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT;if(n===tl)return s.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT}else return null;else if(s=e.get("WEBGL_compressed_texture_s3tc"),s!==null){if(n===jo)return s.COMPRESSED_RGB_S3TC_DXT1_EXT;if(n===$o)return s.COMPRESSED_RGBA_S3TC_DXT1_EXT;if(n===el)return s.COMPRESSED_RGBA_S3TC_DXT3_EXT;if(n===tl)return s.COMPRESSED_RGBA_S3TC_DXT5_EXT}else return null;if(n===Lc||n===Ac||n===Tc||n===Ic)if(s=e.get("WEBGL_compressed_texture_pvrtc"),s!==null){if(n===Lc)return s.COMPRESSED_RGB_PVRTC_4BPPV1_IMG;if(n===Ac)return s.COMPRESSED_RGB_PVRTC_2BPPV1_IMG;if(n===Tc)return s.COMPRESSED_RGBA_PVRTC_4BPPV1_IMG;if(n===Ic)return s.COMPRESSED_RGBA_PVRTC_2BPPV1_IMG}else return null;if(n===Ec||n===wc||n===Rc||n===Dc||n===Pc||n===al||n===Uc)if(s=e.get("WEBGL_compressed_texture_etc"),s!==null){if(n===Ec||n===wc)return r===at?s.COMPRESSED_SRGB8_ETC2:s.COMPRESSED_RGB8_ETC2;if(n===Rc)return r===at?s.COMPRESSED_SRGB8_ALPHA8_ETC2_EAC:s.COMPRESSED_RGBA8_ETC2_EAC;if(n===Dc)return s.COMPRESSED_R11_EAC;if(n===Pc)return s.COMPRESSED_SIGNED_R11_EAC;if(n===al)return s.COMPRESSED_RG11_EAC;if(n===Uc)return s.COMPRESSED_SIGNED_RG11_EAC}else return null;if(n===Bc||n===Oc||n===Nc||n===Fc||n===zc||n===kc||n===Hc||n===Vc||n===Gc||n===qc||n===Wc||n===Xc||n===Yc||n===Zc)if(s=e.get("WEBGL_compressed_texture_astc"),s!==null){if(n===Bc)return r===at?s.COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR:s.COMPRESSED_RGBA_ASTC_4x4_KHR;if(n===Oc)return r===at?s.COMPRESSED_SRGB8_ALPHA8_ASTC_5x4_KHR:s.COMPRESSED_RGBA_ASTC_5x4_KHR;if(n===Nc)return r===at?s.COMPRESSED_SRGB8_ALPHA8_ASTC_5x5_KHR:s.COMPRESSED_RGBA_ASTC_5x5_KHR;if(n===Fc)return r===at?s.COMPRESSED_SRGB8_ALPHA8_ASTC_6x5_KHR:s.COMPRESSED_RGBA_ASTC_6x5_KHR;if(n===zc)return r===at?s.COMPRESSED_SRGB8_ALPHA8_ASTC_6x6_KHR:s.COMPRESSED_RGBA_ASTC_6x6_KHR;if(n===kc)return r===at?s.COMPRESSED_SRGB8_ALPHA8_ASTC_8x5_KHR:s.COMPRESSED_RGBA_ASTC_8x5_KHR;if(n===Hc)return r===at?s.COMPRESSED_SRGB8_ALPHA8_ASTC_8x6_KHR:s.COMPRESSED_RGBA_ASTC_8x6_KHR;if(n===Vc)return r===at?s.COMPRESSED_SRGB8_ALPHA8_ASTC_8x8_KHR:s.COMPRESSED_RGBA_ASTC_8x8_KHR;if(n===Gc)return r===at?s.COMPRESSED_SRGB8_ALPHA8_ASTC_10x5_KHR:s.COMPRESSED_RGBA_ASTC_10x5_KHR;if(n===qc)return r===at?s.COMPRESSED_SRGB8_ALPHA8_ASTC_10x6_KHR:s.COMPRESSED_RGBA_ASTC_10x6_KHR;if(n===Wc)return r===at?s.COMPRESSED_SRGB8_ALPHA8_ASTC_10x8_KHR:s.COMPRESSED_RGBA_ASTC_10x8_KHR;if(n===Xc)return r===at?s.COMPRESSED_SRGB8_ALPHA8_ASTC_10x10_KHR:s.COMPRESSED_RGBA_ASTC_10x10_KHR;if(n===Yc)return r===at?s.COMPRESSED_SRGB8_ALPHA8_ASTC_12x10_KHR:s.COMPRESSED_RGBA_ASTC_12x10_KHR;if(n===Zc)return r===at?s.COMPRESSED_SRGB8_ALPHA8_ASTC_12x12_KHR:s.COMPRESSED_RGBA_ASTC_12x12_KHR}else return null;if(n===Kc||n===Jc||n===Qc)if(s=e.get("EXT_texture_compression_bptc"),s!==null){if(n===Kc)return r===at?s.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT:s.COMPRESSED_RGBA_BPTC_UNORM_EXT;if(n===Jc)return s.COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT;if(n===Qc)return s.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT}else return null;if(n===jc||n===$c||n===nl||n===ef)if(s=e.get("EXT_texture_compression_rgtc"),s!==null){if(n===jc)return s.COMPRESSED_RED_RGTC1_EXT;if(n===$c)return s.COMPRESSED_SIGNED_RED_RGTC1_EXT;if(n===nl)return s.COMPRESSED_RED_GREEN_RGTC2_EXT;if(n===ef)return s.COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT}else return null;return n===Ir?t.UNSIGNED_INT_24_8:t[n]!==void 0?t[n]:null}return{convert:a}}var HT=`
void main() {

	gl_Position = vec4( position, 1.0 );

}`,VT=`
uniform sampler2DArray depthColor;
uniform float depthWidth;
uniform float depthHeight;

void main() {

	vec2 coord = vec2( gl_FragCoord.x / depthWidth, gl_FragCoord.y / depthHeight );

	if ( coord.x >= 1.0 ) {

		gl_FragDepth = texture( depthColor, vec3( coord.x - 1.0, coord.y, 1 ) ).r;

	} else {

		gl_FragDepth = texture( depthColor, vec3( coord.x, coord.y, 0 ) ).r;

	}

}`,xp=class{constructor(){this.texture=null,this.mesh=null,this.depthNear=0,this.depthFar=0}init(e,a){if(this.texture===null){let n=new qo(e.texture);(e.depthNear!==a.depthNear||e.depthFar!==a.depthFar)&&(this.depthNear=e.depthNear,this.depthFar=e.depthFar),this.texture=n}}getMesh(e){if(this.texture!==null&&this.mesh===null){let a=e.cameras[0].viewport,n=new xa({vertexShader:HT,fragmentShader:VT,uniforms:{depthColor:{value:this.texture},depthWidth:{value:a.z},depthHeight:{value:a.w}}});this.mesh=new La(new Ps(20,20),n)}return this.mesh}reset(){this.texture=null,this.mesh=null}getDepthTexture(){return this.texture}},vp=class extends Pn{constructor(e,a){super();let n=this,i=null,s=1,r=null,o="local-floor",l=1,u=null,d=null,p=null,c=null,h=null,v=null,b=typeof XRWebGLBinding<"u",m=new xp,f={},x=a.getContextAttributes(),S=null,_=null,L=[],C=[],T=new qe,y=null,A=new ha;A.viewport=new At;let E=new ha;E.viewport=new At;let w=[A,E],B=new mc,X=null,K=null;this.cameraAutoUpdate=!0,this.enabled=!1,this.isPresenting=!1,this.getController=function(J){let ie=L[J];return ie===void 0&&(ie=new br,L[J]=ie),ie.getTargetRaySpace()},this.getControllerGrip=function(J){let ie=L[J];return ie===void 0&&(ie=new br,L[J]=ie),ie.getGripSpace()},this.getHand=function(J){let ie=L[J];return ie===void 0&&(ie=new br,L[J]=ie),ie.getHandSpace()};function z(J){let ie=C.indexOf(J.inputSource);if(ie===-1)return;let te=L[ie];te!==void 0&&(te.update(J.inputSource,J.frame,u||r),te.dispatchEvent({type:J.type,data:J.inputSource}))}function W(){i.removeEventListener("select",z),i.removeEventListener("selectstart",z),i.removeEventListener("selectend",z),i.removeEventListener("squeeze",z),i.removeEventListener("squeezestart",z),i.removeEventListener("squeezeend",z),i.removeEventListener("end",W),i.removeEventListener("inputsourceschange",V);for(let J=0;J<L.length;J++){let ie=C[J];ie!==null&&(C[J]=null,L[J].disconnect(ie))}X=null,K=null,m.reset();for(let J in f)delete f[J];e.setRenderTarget(S),h=null,c=null,p=null,i=null,_=null,je.stop(),n.isPresenting=!1,e.setPixelRatio(y),e.setSize(T.width,T.height,!1),n.dispatchEvent({type:"sessionend"})}this.setFramebufferScaleFactor=function(J){s=J,n.isPresenting===!0&&Ae("WebXRManager: Cannot change framebuffer scale while presenting.")},this.setReferenceSpaceType=function(J){o=J,n.isPresenting===!0&&Ae("WebXRManager: Cannot change reference space type while presenting.")},this.getReferenceSpace=function(){return u||r},this.setReferenceSpace=function(J){u=J},this.getBaseLayer=function(){return c!==null?c:h},this.getBinding=function(){return p===null&&b&&(p=new XRWebGLBinding(i,a)),p},this.getFrame=function(){return v},this.getSession=function(){return i},this.setSession=async function(J){if(i=J,i!==null){if(S=e.getRenderTarget(),i.addEventListener("select",z),i.addEventListener("selectstart",z),i.addEventListener("selectend",z),i.addEventListener("squeeze",z),i.addEventListener("squeezestart",z),i.addEventListener("squeezeend",z),i.addEventListener("end",W),i.addEventListener("inputsourceschange",V),x.xrCompatible!==!0&&await a.makeXRCompatible(),y=e.getPixelRatio(),e.getSize(T),b&&"createProjectionLayer"in XRWebGLBinding.prototype){let te=null,Re=null,Ue=null;x.depth&&(Ue=x.stencil?a.DEPTH24_STENCIL8:a.DEPTH_COMPONENT24,te=x.stencil?Wi:Dn,Re=x.stencil?Ir:yn);let Te={colorFormat:a.RGBA8,depthFormat:Ue,scaleFactor:s};p=this.getBinding(),c=p.createProjectionLayer(Te),i.updateRenderState({layers:[c]}),e.setPixelRatio(1),e.setSize(c.textureWidth,c.textureHeight,!1),_=new Fa(c.textureWidth,c.textureHeight,{format:tn,type:ka,depthTexture:new ni(c.textureWidth,c.textureHeight,Re,void 0,void 0,void 0,void 0,void 0,void 0,te),stencilBuffer:x.stencil,colorSpace:e.outputColorSpace,samples:x.antialias?4:0,resolveDepthBuffer:c.ignoreDepthValues===!1,resolveStencilBuffer:c.ignoreDepthValues===!1})}else{let te={antialias:x.antialias,alpha:!0,depth:x.depth,stencil:x.stencil,framebufferScaleFactor:s};h=new XRWebGLLayer(i,a,te),i.updateRenderState({baseLayer:h}),e.setPixelRatio(1),e.setSize(h.framebufferWidth,h.framebufferHeight,!1),_=new Fa(h.framebufferWidth,h.framebufferHeight,{format:tn,type:ka,colorSpace:e.outputColorSpace,stencilBuffer:x.stencil,resolveDepthBuffer:h.ignoreDepthValues===!1,resolveStencilBuffer:h.ignoreDepthValues===!1})}_.isXRRenderTarget=!0,this.setFoveation(l),u=null,r=await i.requestReferenceSpace(o),je.setContext(i),je.start(),n.isPresenting=!0,n.dispatchEvent({type:"sessionstart"})}},this.getEnvironmentBlendMode=function(){if(i!==null)return i.environmentBlendMode},this.getDepthTexture=function(){return m.getDepthTexture()};function V(J){for(let ie=0;ie<J.removed.length;ie++){let te=J.removed[ie],Re=C.indexOf(te);Re>=0&&(C[Re]=null,L[Re].disconnect(te))}for(let ie=0;ie<J.added.length;ie++){let te=J.added[ie],Re=C.indexOf(te);if(Re===-1){for(let Te=0;Te<L.length;Te++)if(Te>=C.length){C.push(te),Re=Te;break}else if(C[Te]===null){C[Te]=te,Re=Te;break}if(Re===-1)break}let Ue=L[Re];Ue&&Ue.connect(te)}}let j=new F,ee=new F;function fe(J,ie,te){j.setFromMatrixPosition(ie.matrixWorld),ee.setFromMatrixPosition(te.matrixWorld);let Re=j.distanceTo(ee),Ue=ie.projectionMatrix.elements,Te=te.projectionMatrix.elements,Pt=Ue[14]/(Ue[10]-1),Ve=Ue[14]/(Ue[10]+1),ut=(Ue[9]+1)/Ue[5],$e=(Ue[9]-1)/Ue[5],Ze=(Ue[8]-1)/Ue[0],zt=(Te[8]+1)/Te[0],Xt=Pt*Ze,Qt=Pt*zt,na=Re/(-Ze+zt),It=na*-Ze;if(ie.matrixWorld.decompose(J.position,J.quaternion,J.scale),J.translateX(It),J.translateZ(na),J.matrixWorld.compose(J.position,J.quaternion,J.scale),J.matrixWorldInverse.copy(J.matrixWorld).invert(),Ue[10]===-1)J.projectionMatrix.copy(ie.projectionMatrix),J.projectionMatrixInverse.copy(ie.projectionMatrixInverse);else{let kt=Pt+na,D=Ve+na,Ma=Xt-It,nt=Qt+(Re-It),I=ut*Ve/D*kt,g=$e*Ve/D*kt;J.projectionMatrix.makePerspective(Ma,nt,I,g,kt,D),J.projectionMatrixInverse.copy(J.projectionMatrix).invert()}}function me(J,ie){ie===null?J.matrixWorld.copy(J.matrix):J.matrixWorld.multiplyMatrices(ie.matrixWorld,J.matrix),J.matrixWorldInverse.copy(J.matrixWorld).invert()}this.updateCamera=function(J){if(i===null)return;let ie=J.near,te=J.far;m.texture!==null&&(m.depthNear>0&&(ie=m.depthNear),m.depthFar>0&&(te=m.depthFar)),B.near=E.near=A.near=ie,B.far=E.far=A.far=te,(X!==B.near||K!==B.far)&&(i.updateRenderState({depthNear:B.near,depthFar:B.far}),X=B.near,K=B.far),B.layers.mask=J.layers.mask|6,A.layers.mask=B.layers.mask&-5,E.layers.mask=B.layers.mask&-3;let Re=J.parent,Ue=B.cameras;me(B,Re);for(let Te=0;Te<Ue.length;Te++)me(Ue[Te],Re);Ue.length===2?fe(B,A,E):B.projectionMatrix.copy(A.projectionMatrix),ve(J,B,Re)};function ve(J,ie,te){te===null?J.matrix.copy(ie.matrixWorld):(J.matrix.copy(te.matrixWorld),J.matrix.invert(),J.matrix.multiply(ie.matrixWorld)),J.matrix.decompose(J.position,J.quaternion,J.scale),J.updateMatrixWorld(!0),J.projectionMatrix.copy(ie.projectionMatrix),J.projectionMatrixInverse.copy(ie.projectionMatrixInverse),J.isPerspectiveCamera&&(J.fov=Zu*2*Math.atan(1/J.projectionMatrix.elements[5]),J.zoom=1)}this.getCamera=function(){return B},this.getFoveation=function(){if(!(c===null&&h===null))return l},this.setFoveation=function(J){l=J,c!==null&&(c.fixedFoveation=J),h!==null&&h.fixedFoveation!==void 0&&(h.fixedFoveation=J)},this.hasDepthSensing=function(){return m.texture!==null},this.getDepthSensingMesh=function(){return m.getMesh(B)},this.getCameraTexture=function(J){return f[J]};let Qe=null;function Tt(J,ie){if(d=ie.getViewerPose(u||r),v=ie,d!==null){let te=d.views;h!==null&&(e.setRenderTargetFramebuffer(_,h.framebuffer),e.setRenderTarget(_));let Re=!1;te.length!==B.cameras.length&&(B.cameras.length=0,Re=!0);for(let Ve=0;Ve<te.length;Ve++){let ut=te[Ve],$e=null;if(h!==null)$e=h.getViewport(ut);else{let zt=p.getViewSubImage(c,ut);$e=zt.viewport,Ve===0&&(e.setRenderTargetTextures(_,zt.colorTexture,zt.depthStencilTexture),e.setRenderTarget(_))}let Ze=w[Ve];Ze===void 0&&(Ze=new ha,Ze.layers.enable(Ve),Ze.viewport=new At,w[Ve]=Ze),Ze.matrix.fromArray(ut.transform.matrix),Ze.matrix.decompose(Ze.position,Ze.quaternion,Ze.scale),Ze.projectionMatrix.fromArray(ut.projectionMatrix),Ze.projectionMatrixInverse.copy(Ze.projectionMatrix).invert(),Ze.viewport.set($e.x,$e.y,$e.width,$e.height),Ve===0&&(B.matrix.copy(Ze.matrix),B.matrix.decompose(B.position,B.quaternion,B.scale)),Re===!0&&B.cameras.push(Ze)}let Ue=i.enabledFeatures;if(Ue&&Ue.includes("depth-sensing")&&i.depthUsage=="gpu-optimized"&&b){p=n.getBinding();let Ve=p.getDepthInformation(te[0]);Ve&&Ve.isValid&&Ve.texture&&m.init(Ve,i.renderState)}if(Ue&&Ue.includes("camera-access")&&b){e.state.unbindTexture(),p=n.getBinding();for(let Ve=0;Ve<te.length;Ve++){let ut=te[Ve].camera;if(ut){let $e=f[ut];$e||($e=new qo,f[ut]=$e);let Ze=p.getCameraImage(ut);$e.sourceTexture=Ze}}}}for(let te=0;te<L.length;te++){let Re=C[te],Ue=L[te];Re!==null&&Ue!==void 0&&Ue.update(Re,ie,u||r)}Qe&&Qe(J,ie),ie.detectedPlanes&&n.dispatchEvent({type:"planesdetected",data:ie}),v=null}let je=new Q0;je.setAnimationLoop(Tt),this.setAnimationLoop=function(J){Qe=J},this.dispose=function(){}}},GT=new Ot,nv=new De;nv.set(-1,0,0,0,1,0,0,0,1);function qT(t,e){function a(m,f){m.matrixAutoUpdate===!0&&m.updateMatrix(),f.value.copy(m.matrix)}function n(m,f){f.color.getRGB(m.fogColor.value,ep(t)),f.isFog?(m.fogNear.value=f.near,m.fogFar.value=f.far):f.isFogExp2&&(m.fogDensity.value=f.density)}function i(m,f,x,S,_){f.isNodeMaterial?f.uniformsNeedUpdate=!1:f.isMeshBasicMaterial?s(m,f):f.isMeshLambertMaterial?(s(m,f),f.envMap&&(m.envMapIntensity.value=f.envMapIntensity)):f.isMeshToonMaterial?(s(m,f),p(m,f)):f.isMeshPhongMaterial?(s(m,f),d(m,f),f.envMap&&(m.envMapIntensity.value=f.envMapIntensity)):f.isMeshStandardMaterial?(s(m,f),c(m,f),f.isMeshPhysicalMaterial&&h(m,f,_)):f.isMeshMatcapMaterial?(s(m,f),v(m,f)):f.isMeshDepthMaterial?s(m,f):f.isMeshDistanceMaterial?(s(m,f),b(m,f)):f.isMeshNormalMaterial?s(m,f):f.isLineBasicMaterial?(r(m,f),f.isLineDashedMaterial&&o(m,f)):f.isPointsMaterial?l(m,f,x,S):f.isSpriteMaterial?u(m,f):f.isShadowMaterial?(m.color.value.copy(f.color),m.opacity.value=f.opacity):f.isShaderMaterial&&(f.uniformsNeedUpdate=!1)}function s(m,f){m.opacity.value=f.opacity,f.color&&m.diffuse.value.copy(f.color),f.emissive&&m.emissive.value.copy(f.emissive).multiplyScalar(f.emissiveIntensity),f.map&&(m.map.value=f.map,a(f.map,m.mapTransform)),f.alphaMap&&(m.alphaMap.value=f.alphaMap,a(f.alphaMap,m.alphaMapTransform)),f.bumpMap&&(m.bumpMap.value=f.bumpMap,a(f.bumpMap,m.bumpMapTransform),m.bumpScale.value=f.bumpScale,f.side===va&&(m.bumpScale.value*=-1)),f.normalMap&&(m.normalMap.value=f.normalMap,a(f.normalMap,m.normalMapTransform),m.normalScale.value.copy(f.normalScale),f.side===va&&m.normalScale.value.negate()),f.displacementMap&&(m.displacementMap.value=f.displacementMap,a(f.displacementMap,m.displacementMapTransform),m.displacementScale.value=f.displacementScale,m.displacementBias.value=f.displacementBias),f.emissiveMap&&(m.emissiveMap.value=f.emissiveMap,a(f.emissiveMap,m.emissiveMapTransform)),f.specularMap&&(m.specularMap.value=f.specularMap,a(f.specularMap,m.specularMapTransform)),f.alphaTest>0&&(m.alphaTest.value=f.alphaTest);let x=e.get(f),S=x.envMap,_=x.envMapRotation;S&&(m.envMap.value=S,m.envMapRotation.value.setFromMatrix4(GT.makeRotationFromEuler(_)).transpose(),S.isCubeTexture&&S.isRenderTargetTexture===!1&&m.envMapRotation.value.premultiply(nv),m.reflectivity.value=f.reflectivity,m.ior.value=f.ior,m.refractionRatio.value=f.refractionRatio),f.lightMap&&(m.lightMap.value=f.lightMap,m.lightMapIntensity.value=f.lightMapIntensity,a(f.lightMap,m.lightMapTransform)),f.aoMap&&(m.aoMap.value=f.aoMap,m.aoMapIntensity.value=f.aoMapIntensity,a(f.aoMap,m.aoMapTransform))}function r(m,f){m.diffuse.value.copy(f.color),m.opacity.value=f.opacity,f.map&&(m.map.value=f.map,a(f.map,m.mapTransform))}function o(m,f){m.dashSize.value=f.dashSize,m.totalSize.value=f.dashSize+f.gapSize,m.scale.value=f.scale}function l(m,f,x,S){m.diffuse.value.copy(f.color),m.opacity.value=f.opacity,m.size.value=f.size*x,m.scale.value=S*.5,f.map&&(m.map.value=f.map,a(f.map,m.uvTransform)),f.alphaMap&&(m.alphaMap.value=f.alphaMap,a(f.alphaMap,m.alphaMapTransform)),f.alphaTest>0&&(m.alphaTest.value=f.alphaTest)}function u(m,f){m.diffuse.value.copy(f.color),m.opacity.value=f.opacity,m.rotation.value=f.rotation,f.map&&(m.map.value=f.map,a(f.map,m.mapTransform)),f.alphaMap&&(m.alphaMap.value=f.alphaMap,a(f.alphaMap,m.alphaMapTransform)),f.alphaTest>0&&(m.alphaTest.value=f.alphaTest)}function d(m,f){m.specular.value.copy(f.specular),m.shininess.value=Math.max(f.shininess,1e-4)}function p(m,f){f.gradientMap&&(m.gradientMap.value=f.gradientMap)}function c(m,f){m.metalness.value=f.metalness,f.metalnessMap&&(m.metalnessMap.value=f.metalnessMap,a(f.metalnessMap,m.metalnessMapTransform)),m.roughness.value=f.roughness,f.roughnessMap&&(m.roughnessMap.value=f.roughnessMap,a(f.roughnessMap,m.roughnessMapTransform)),f.envMap&&(m.envMapIntensity.value=f.envMapIntensity)}function h(m,f,x){m.ior.value=f.ior,f.sheen>0&&(m.sheenColor.value.copy(f.sheenColor).multiplyScalar(f.sheen),m.sheenRoughness.value=f.sheenRoughness,f.sheenColorMap&&(m.sheenColorMap.value=f.sheenColorMap,a(f.sheenColorMap,m.sheenColorMapTransform)),f.sheenRoughnessMap&&(m.sheenRoughnessMap.value=f.sheenRoughnessMap,a(f.sheenRoughnessMap,m.sheenRoughnessMapTransform))),f.clearcoat>0&&(m.clearcoat.value=f.clearcoat,m.clearcoatRoughness.value=f.clearcoatRoughness,f.clearcoatMap&&(m.clearcoatMap.value=f.clearcoatMap,a(f.clearcoatMap,m.clearcoatMapTransform)),f.clearcoatRoughnessMap&&(m.clearcoatRoughnessMap.value=f.clearcoatRoughnessMap,a(f.clearcoatRoughnessMap,m.clearcoatRoughnessMapTransform)),f.clearcoatNormalMap&&(m.clearcoatNormalMap.value=f.clearcoatNormalMap,a(f.clearcoatNormalMap,m.clearcoatNormalMapTransform),m.clearcoatNormalScale.value.copy(f.clearcoatNormalScale),f.side===va&&m.clearcoatNormalScale.value.negate())),f.dispersion>0&&(m.dispersion.value=f.dispersion),f.iridescence>0&&(m.iridescence.value=f.iridescence,m.iridescenceIOR.value=f.iridescenceIOR,m.iridescenceThicknessMinimum.value=f.iridescenceThicknessRange[0],m.iridescenceThicknessMaximum.value=f.iridescenceThicknessRange[1],f.iridescenceMap&&(m.iridescenceMap.value=f.iridescenceMap,a(f.iridescenceMap,m.iridescenceMapTransform)),f.iridescenceThicknessMap&&(m.iridescenceThicknessMap.value=f.iridescenceThicknessMap,a(f.iridescenceThicknessMap,m.iridescenceThicknessMapTransform))),f.transmission>0&&(m.transmission.value=f.transmission,m.transmissionSamplerMap.value=x.texture,m.transmissionSamplerSize.value.set(x.width,x.height),f.transmissionMap&&(m.transmissionMap.value=f.transmissionMap,a(f.transmissionMap,m.transmissionMapTransform)),m.thickness.value=f.thickness,f.thicknessMap&&(m.thicknessMap.value=f.thicknessMap,a(f.thicknessMap,m.thicknessMapTransform)),m.attenuationDistance.value=f.attenuationDistance,m.attenuationColor.value.copy(f.attenuationColor)),f.anisotropy>0&&(m.anisotropyVector.value.set(f.anisotropy*Math.cos(f.anisotropyRotation),f.anisotropy*Math.sin(f.anisotropyRotation)),f.anisotropyMap&&(m.anisotropyMap.value=f.anisotropyMap,a(f.anisotropyMap,m.anisotropyMapTransform))),m.specularIntensity.value=f.specularIntensity,m.specularColor.value.copy(f.specularColor),f.specularColorMap&&(m.specularColorMap.value=f.specularColorMap,a(f.specularColorMap,m.specularColorMapTransform)),f.specularIntensityMap&&(m.specularIntensityMap.value=f.specularIntensityMap,a(f.specularIntensityMap,m.specularIntensityMapTransform))}function v(m,f){f.matcap&&(m.matcap.value=f.matcap)}function b(m,f){let x=e.get(f).light;m.referencePosition.value.setFromMatrixPosition(x.matrixWorld),m.nearDistance.value=x.shadow.camera.near,m.farDistance.value=x.shadow.camera.far}return{refreshFogUniforms:n,refreshMaterialUniforms:i}}function WT(t,e,a,n){let i={},s={},r=[],o=t.getParameter(t.MAX_UNIFORM_BUFFER_BINDINGS);function l(_,L){let C=L.program;n.uniformBlockBinding(_,C)}function u(_,L){let C=i[_.id];C===void 0&&(m(_),C=d(_),i[_.id]=C,_.addEventListener("dispose",x));let T=L.program;n.updateUBOMapping(_,T);let y=e.render.frame;s[_.id]!==y&&(c(_),s[_.id]=y)}function d(_){let L=p();_.__bindingPointIndex=L;let C=t.createBuffer(),T=_.__size,y=_.usage;return t.bindBuffer(t.UNIFORM_BUFFER,C),t.bufferData(t.UNIFORM_BUFFER,T,y),t.bindBuffer(t.UNIFORM_BUFFER,null),t.bindBufferBase(t.UNIFORM_BUFFER,L,C),C}function p(){for(let _=0;_<o;_++)if(r.indexOf(_)===-1)return r.push(_),_;return Ee("WebGLRenderer: Maximum number of simultaneously usable uniforms groups reached."),0}function c(_){let L=i[_.id],C=_.uniforms,T=_.__cache;t.bindBuffer(t.UNIFORM_BUFFER,L);for(let y=0,A=C.length;y<A;y++){let E=C[y];if(Array.isArray(E))for(let w=0,B=E.length;w<B;w++)h(E[w],y,w,T);else h(E,y,0,T)}t.bindBuffer(t.UNIFORM_BUFFER,null)}function h(_,L,C,T){if(b(_,L,C,T)===!0){let y=_.__offset,A=_.value;if(Array.isArray(A)){let E=0;for(let w=0;w<A.length;w++){let B=A[w],X=f(B);v(B,_.__data,E),typeof B!="number"&&typeof B!="boolean"&&!B.isMatrix3&&!ArrayBuffer.isView(B)&&(E+=X.storage/Float32Array.BYTES_PER_ELEMENT)}}else v(A,_.__data,0);t.bufferSubData(t.UNIFORM_BUFFER,y,_.__data)}}function v(_,L,C){typeof _=="number"||typeof _=="boolean"?L[0]=_:_.isMatrix3?(L[0]=_.elements[0],L[1]=_.elements[1],L[2]=_.elements[2],L[3]=0,L[4]=_.elements[3],L[5]=_.elements[4],L[6]=_.elements[5],L[7]=0,L[8]=_.elements[6],L[9]=_.elements[7],L[10]=_.elements[8],L[11]=0):ArrayBuffer.isView(_)?L.set(new _.constructor(_.buffer,_.byteOffset,L.length)):_.toArray(L,C)}function b(_,L,C,T){let y=_.value,A=L+"_"+C;if(T[A]===void 0)return typeof y=="number"||typeof y=="boolean"?T[A]=y:ArrayBuffer.isView(y)?T[A]=y.slice():T[A]=y.clone(),!0;{let E=T[A];if(typeof y=="number"||typeof y=="boolean"){if(E!==y)return T[A]=y,!0}else{if(ArrayBuffer.isView(y))return!0;if(E.equals(y)===!1)return E.copy(y),!0}}return!1}function m(_){let L=_.uniforms,C=0,T=16;for(let A=0,E=L.length;A<E;A++){let w=Array.isArray(L[A])?L[A]:[L[A]];for(let B=0,X=w.length;B<X;B++){let K=w[B],z=Array.isArray(K.value)?K.value:[K.value];for(let W=0,V=z.length;W<V;W++){let j=z[W],ee=f(j),fe=C%T,me=fe%ee.boundary,ve=fe+me;C+=me,ve!==0&&T-ve<ee.storage&&(C+=T-ve),K.__data=new Float32Array(ee.storage/Float32Array.BYTES_PER_ELEMENT),K.__offset=C,C+=ee.storage}}}let y=C%T;return y>0&&(C+=T-y),_.__size=C,_.__cache={},this}function f(_){let L={boundary:0,storage:0};return typeof _=="number"||typeof _=="boolean"?(L.boundary=4,L.storage=4):_.isVector2?(L.boundary=8,L.storage=8):_.isVector3||_.isColor?(L.boundary=16,L.storage=12):_.isVector4?(L.boundary=16,L.storage=16):_.isMatrix3?(L.boundary=48,L.storage=48):_.isMatrix4?(L.boundary=64,L.storage=64):_.isTexture?Ae("WebGLRenderer: Texture samplers can not be part of an uniforms group."):ArrayBuffer.isView(_)?(L.boundary=16,L.storage=_.byteLength):Ae("WebGLRenderer: Unsupported uniform value type.",_),L}function x(_){let L=_.target;L.removeEventListener("dispose",x);let C=r.indexOf(L.__bindingPointIndex);r.splice(C,1),t.deleteBuffer(i[L.id]),delete i[L.id],delete s[L.id]}function S(){for(let _ in i)t.deleteBuffer(i[_]);r=[],i={},s={}}return{bind:l,update:u,dispose:S}}var XT=new Uint16Array([12469,15057,12620,14925,13266,14620,13807,14376,14323,13990,14545,13625,14713,13328,14840,12882,14931,12528,14996,12233,15039,11829,15066,11525,15080,11295,15085,10976,15082,10705,15073,10495,13880,14564,13898,14542,13977,14430,14158,14124,14393,13732,14556,13410,14702,12996,14814,12596,14891,12291,14937,11834,14957,11489,14958,11194,14943,10803,14921,10506,14893,10278,14858,9960,14484,14039,14487,14025,14499,13941,14524,13740,14574,13468,14654,13106,14743,12678,14818,12344,14867,11893,14889,11509,14893,11180,14881,10751,14852,10428,14812,10128,14765,9754,14712,9466,14764,13480,14764,13475,14766,13440,14766,13347,14769,13070,14786,12713,14816,12387,14844,11957,14860,11549,14868,11215,14855,10751,14825,10403,14782,10044,14729,9651,14666,9352,14599,9029,14967,12835,14966,12831,14963,12804,14954,12723,14936,12564,14917,12347,14900,11958,14886,11569,14878,11247,14859,10765,14828,10401,14784,10011,14727,9600,14660,9289,14586,8893,14508,8533,15111,12234,15110,12234,15104,12216,15092,12156,15067,12010,15028,11776,14981,11500,14942,11205,14902,10752,14861,10393,14812,9991,14752,9570,14682,9252,14603,8808,14519,8445,14431,8145,15209,11449,15208,11451,15202,11451,15190,11438,15163,11384,15117,11274,15055,10979,14994,10648,14932,10343,14871,9936,14803,9532,14729,9218,14645,8742,14556,8381,14461,8020,14365,7603,15273,10603,15272,10607,15267,10619,15256,10631,15231,10614,15182,10535,15118,10389,15042,10167,14963,9787,14883,9447,14800,9115,14710,8665,14615,8318,14514,7911,14411,7507,14279,7198,15314,9675,15313,9683,15309,9712,15298,9759,15277,9797,15229,9773,15166,9668,15084,9487,14995,9274,14898,8910,14800,8539,14697,8234,14590,7790,14479,7409,14367,7067,14178,6621,15337,8619,15337,8631,15333,8677,15325,8769,15305,8871,15264,8940,15202,8909,15119,8775,15022,8565,14916,8328,14804,8009,14688,7614,14569,7287,14448,6888,14321,6483,14088,6171,15350,7402,15350,7419,15347,7480,15340,7613,15322,7804,15287,7973,15229,8057,15148,8012,15046,7846,14933,7611,14810,7357,14682,7069,14552,6656,14421,6316,14251,5948,14007,5528,15356,5942,15356,5977,15353,6119,15348,6294,15332,6551,15302,6824,15249,7044,15171,7122,15070,7050,14949,6861,14818,6611,14679,6349,14538,6067,14398,5651,14189,5311,13935,4958,15359,4123,15359,4153,15356,4296,15353,4646,15338,5160,15311,5508,15263,5829,15188,6042,15088,6094,14966,6001,14826,5796,14678,5543,14527,5287,14377,4985,14133,4586,13869,4257,15360,1563,15360,1642,15358,2076,15354,2636,15341,3350,15317,4019,15273,4429,15203,4732,15105,4911,14981,4932,14836,4818,14679,4621,14517,4386,14359,4156,14083,3795,13808,3437,15360,122,15360,137,15358,285,15355,636,15344,1274,15322,2177,15281,2765,15215,3223,15120,3451,14995,3569,14846,3567,14681,3466,14511,3305,14344,3121,14037,2800,13753,2467,15360,0,15360,1,15359,21,15355,89,15346,253,15325,479,15287,796,15225,1148,15133,1492,15008,1749,14856,1882,14685,1886,14506,1783,14324,1608,13996,1398,13702,1183]),zn=null;function YT(){return zn===null&&(zn=new $u(XT,16,16,Xi,Fn),zn.name="DFG_LUT",zn.minFilter=ia,zn.magFilter=ia,zn.wrapS=Rn,zn.wrapT=Rn,zn.generateMipmaps=!1,zn.needsUpdate=!0),zn}var lf=class{constructor(e={}){let{canvas:a=M0(),context:n=null,depth:i=!0,stencil:s=!1,alpha:r=!1,antialias:o=!1,premultipliedAlpha:l=!0,preserveDrawingBuffer:u=!1,powerPreference:d="default",failIfMajorPerformanceCaveat:p=!1,reversedDepthBuffer:c=!1,outputBufferType:h=ka}=e;this.isWebGLRenderer=!0;let v;if(n!==null){if(typeof WebGLRenderingContext<"u"&&n instanceof WebGLRenderingContext)throw new Error("THREE.WebGLRenderer: WebGL 1 is not supported since r163.");v=n.getContextAttributes().alpha}else v=r;let b=h,m=new Set([Cc,bc,Mc]),f=new Set([ka,yn,Tr,Ir,_c,Sc]),x=new Uint32Array(4),S=new Int32Array(4),_=new F,L=null,C=null,T=[],y=[],A=null;this.domElement=a,this.debug={checkShaderErrors:!0,onShaderError:null},this.autoClear=!0,this.autoClearColor=!0,this.autoClearDepth=!0,this.autoClearStencil=!0,this.sortObjects=!0,this.clippingPlanes=[],this.localClippingEnabled=!1,this.toneMapping=vn,this.toneMappingExposure=1,this.transmissionResolutionScale=1;let E=this,w=!1,B=null,X=null,K=null,z=null;this._outputColorSpace=ga;let W=0,V=0,j=null,ee=-1,fe=null,me=new At,ve=new At,Qe=null,Tt=new Je(0),je=0,J=a.width,ie=a.height,te=1,Re=null,Ue=null,Te=new At(0,0,J,ie),Pt=new At(0,0,J,ie),Ve=!1,ut=new Vo,$e=!1,Ze=!1,zt=new Ot,Xt=new F,Qt=new At,na={background:null,fog:null,environment:null,overrideMaterial:null,isScene:!0},It=!1;function kt(){return j===null?te:1}let D=n;function Ma(M,P){return a.getContext(M,P)}try{let M={alpha:!0,depth:i,stencil:s,antialias:o,premultipliedAlpha:l,preserveDrawingBuffer:u,powerPreference:d,failIfMajorPerformanceCaveat:p};if("setAttribute"in a&&a.setAttribute("data-engine",`three.js r${"185"}`),a.addEventListener("webglcontextlost",Et,!1),a.addEventListener("webglcontextrestored",ht,!1),a.addEventListener("webglcontextcreationerror",Ln,!1),D===null){let P="webgl2";if(D=Ma(P,M),D===null)throw Ma(P)?new Error("THREE.WebGLRenderer: Error creating WebGL context with your selected attributes."):new Error("THREE.WebGLRenderer: Error creating WebGL context.")}}catch(M){throw Ee("WebGLRenderer: "+M.message),M}let nt,I,g,U,k,G,ae,se,q,Z,re,Me,ue,oe,Le,Ie,Be,R,ne,Y,le,pe,$;function Se(){nt=new e1(D),nt.init(),le=new kT(D,nt),I=new XA(D,nt,e,le),g=new FT(D,nt),I.reversedDepthBuffer&&c&&g.buffers.depth.setReversed(!0),X=D.createFramebuffer(),K=D.createFramebuffer(),z=D.createFramebuffer(),U=new n1(D),k=new CT,G=new zT(D,nt,g,k,I,le,U),ae=new $A(E),se=new oC(D),pe=new qA(D,se),q=new t1(D,se,U,pe),Z=new s1(D,q,se,pe,U),R=new i1(D,I,G),Le=new YA(k),re=new bT(E,ae,nt,I,pe,Le),Me=new qT(E,k),ue=new AT,oe=new DT(nt),Be=new GA(E,ae,g,Z,v,l),Ie=new NT(E,Z,I),$=new WT(D,U,I,g),ne=new WA(D,nt,U),Y=new a1(D,nt,U),U.programs=re.programs,E.capabilities=I,E.extensions=nt,E.properties=k,E.renderLists=ue,E.shadowMap=Ie,E.state=g,E.info=U}Se(),b!==ka&&(A=new o1(b,a.width,a.height,o,i,s));let ye=new vp(E,D);this.xr=ye,this.getContext=function(){return D},this.getContextAttributes=function(){return D.getContextAttributes()},this.forceContextLoss=function(){let M=nt.get("WEBGL_lose_context");M&&M.loseContext()},this.forceContextRestore=function(){let M=nt.get("WEBGL_lose_context");M&&M.restoreContext()},this.getPixelRatio=function(){return te},this.setPixelRatio=function(M){M!==void 0&&(te=M,this.setSize(J,ie,!1))},this.getSize=function(M){return M.set(J,ie)},this.setSize=function(M,P,H=!0){if(ye.isPresenting){Ae("WebGLRenderer: Can't change size while VR device is presenting.");return}J=M,ie=P,a.width=Math.floor(M*te),a.height=Math.floor(P*te),H===!0&&(a.style.width=M+"px",a.style.height=P+"px"),A!==null&&A.setSize(a.width,a.height),this.setViewport(0,0,M,P)},this.getDrawingBufferSize=function(M){return M.set(J*te,ie*te).floor()},this.setDrawingBufferSize=function(M,P,H){J=M,ie=P,te=H,a.width=Math.floor(M*H),a.height=Math.floor(P*H),this.setViewport(0,0,M,P)},this.setEffects=function(M){if(b===ka){Ee("WebGLRenderer: setEffects() requires outputBufferType set to HalfFloatType or FloatType.");return}if(M){for(let P=0;P<M.length;P++)if(M[P].isOutputPass===!0){Ae("WebGLRenderer: OutputPass is not needed in setEffects(). Tone mapping and color space conversion are applied automatically.");break}}A.setEffects(M||[])},this.getCurrentViewport=function(M){return M.copy(me)},this.getViewport=function(M){return M.copy(Te)},this.setViewport=function(M,P,H,O){M.isVector4?Te.set(M.x,M.y,M.z,M.w):Te.set(M,P,H,O),g.viewport(me.copy(Te).multiplyScalar(te).round())},this.getScissor=function(M){return M.copy(Pt)},this.setScissor=function(M,P,H,O){M.isVector4?Pt.set(M.x,M.y,M.z,M.w):Pt.set(M,P,H,O),g.scissor(ve.copy(Pt).multiplyScalar(te).round())},this.getScissorTest=function(){return Ve},this.setScissorTest=function(M){g.setScissorTest(Ve=M)},this.setOpaqueSort=function(M){Re=M},this.setTransparentSort=function(M){Ue=M},this.getClearColor=function(M){return M.copy(Be.getClearColor())},this.setClearColor=function(){Be.setClearColor(...arguments)},this.getClearAlpha=function(){return Be.getClearAlpha()},this.setClearAlpha=function(){Be.setClearAlpha(...arguments)},this.clear=function(M=!0,P=!0,H=!0){let O=0;if(M){let N=!1;if(j!==null){let he=j.texture.format;N=m.has(he)}if(N){let he=j.texture.type,xe=f.has(he),de=Be.getClearColor(),_e=Be.getClearAlpha(),be=de.r,Oe=de.g,ze=de.b;xe?(x[0]=be,x[1]=Oe,x[2]=ze,x[3]=_e,D.clearBufferuiv(D.COLOR,0,x)):(S[0]=be,S[1]=Oe,S[2]=ze,S[3]=_e,D.clearBufferiv(D.COLOR,0,S))}else O|=D.COLOR_BUFFER_BIT}P&&(O|=D.DEPTH_BUFFER_BIT,this.state.buffers.depth.setMask(!0)),H&&(O|=D.STENCIL_BUFFER_BIT,this.state.buffers.stencil.setMask(4294967295)),O!==0&&D.clear(O)},this.clearColor=function(){this.clear(!0,!1,!1)},this.clearDepth=function(){this.clear(!1,!0,!1)},this.clearStencil=function(){this.clear(!1,!1,!0)},this.setNodesHandler=function(M){M.setRenderer(this),B=M},this.dispose=function(){a.removeEventListener("webglcontextlost",Et,!1),a.removeEventListener("webglcontextrestored",ht,!1),a.removeEventListener("webglcontextcreationerror",Ln,!1),Be.dispose(),ue.dispose(),oe.dispose(),k.dispose(),ae.dispose(),Z.dispose(),pe.dispose(),$.dispose(),re.dispose(),ye.dispose(),ye.removeEventListener("sessionstart",$g),ye.removeEventListener("sessionend",ex),Ms.stop()};function Et(M){M.preventDefault(),$h("WebGLRenderer: Context Lost."),w=!0}function ht(){$h("WebGLRenderer: Context Restored."),w=!1;let M=U.autoReset,P=Ie.enabled,H=Ie.autoUpdate,O=Ie.needsUpdate,N=Ie.type;Se(),U.autoReset=M,Ie.enabled=P,Ie.autoUpdate=H,Ie.needsUpdate=O,Ie.type=N}function Ln(M){Ee("WebGLRenderer: A WebGL context could not be created. Reason: ",M.statusMessage)}function An(M){let P=M.target;P.removeEventListener("dispose",An),ZM(P)}function ZM(M){KM(M),k.remove(M)}function KM(M){let P=k.get(M).programs;P!==void 0&&(P.forEach(function(H){re.releaseProgram(H)}),M.isShaderMaterial&&re.releaseShaderCache(M))}this.renderBufferDirect=function(M,P,H,O,N,he){P===null&&(P=na);let xe=N.isMesh&&N.matrixWorld.determinantAffine()<0,de=jM(M,P,H,O,N);g.setMaterial(O,xe);let _e=H.index,be=1;if(O.wireframe===!0){if(_e=q.getWireframeAttribute(H),_e===void 0)return;be=2}let Oe=H.drawRange,ze=H.attributes.position,Ce=Oe.start*be,rt=(Oe.start+Oe.count)*be;he!==null&&(Ce=Math.max(Ce,he.start*be),rt=Math.min(rt,(he.start+he.count)*be)),_e!==null?(Ce=Math.max(Ce,0),rt=Math.min(rt,_e.count)):ze!=null&&(Ce=Math.max(Ce,0),rt=Math.min(rt,ze.count));let Ut=rt-Ce;if(Ut<0||Ut===1/0)return;pe.setup(N,O,de,H,_e);let wt,ct=ne;if(_e!==null&&(wt=se.get(_e),ct=Y,ct.setIndex(wt)),N.isMesh)O.wireframe===!0?(g.setLineWidth(O.wireframeLinewidth*kt()),ct.setMode(D.LINES)):ct.setMode(D.TRIANGLES);else if(N.isLine){let ca=O.linewidth;ca===void 0&&(ca=1),g.setLineWidth(ca*kt()),N.isLineSegments?ct.setMode(D.LINES):N.isLineLoop?ct.setMode(D.LINE_LOOP):ct.setMode(D.LINE_STRIP)}else N.isPoints?ct.setMode(D.POINTS):N.isSprite&&ct.setMode(D.TRIANGLES);if(N.isBatchedMesh)if(nt.get("WEBGL_multi_draw"))ct.renderMultiDraw(N._multiDrawStarts,N._multiDrawCounts,N._multiDrawCount);else{let ca=N._multiDrawStarts,ge=N._multiDrawCounts,Pa=N._multiDrawCount,Ke=_e?se.get(_e).bytesPerElement:1,Qa=k.get(O).currentProgram.getUniforms();for(let Tn=0;Tn<Pa;Tn++)Qa.setValue(D,"_gl_DrawID",Tn),ct.render(ca[Tn]/Ke,ge[Tn])}else if(N.isInstancedMesh)ct.renderInstances(Ce,Ut,N.count);else if(H.isInstancedBufferGeometry){let ca=H._maxInstanceCount!==void 0?H._maxInstanceCount:1/0,ge=Math.min(H.instanceCount,ca);ct.renderInstances(Ce,Ut,ge)}else ct.render(Ce,Ut)};function jg(M,P,H){M.transparent===!0&&M.side===On&&M.forceSinglePass===!1?(M.side=va,M.needsUpdate=!0,cu(M,P,H),M.side=ai,M.needsUpdate=!0,cu(M,P,H),M.side=On):cu(M,P,H)}this.compile=function(M,P,H=null){H===null&&(H=M),C=oe.get(H),C.init(P),y.push(C),H.traverseVisible(function(N){N.isLight&&N.layers.test(P.layers)&&(C.pushLight(N),N.castShadow&&C.pushShadow(N))}),M!==H&&M.traverseVisible(function(N){N.isLight&&N.layers.test(P.layers)&&(C.pushLight(N),N.castShadow&&C.pushShadow(N))}),C.setupLights();let O=new Set;return M.traverse(function(N){if(!(N.isMesh||N.isPoints||N.isLine||N.isSprite))return;let he=N.material;if(he)if(Array.isArray(he))for(let xe=0;xe<he.length;xe++){let de=he[xe];jg(de,H,N),O.add(de)}else jg(he,H,N),O.add(he)}),C=y.pop(),O},this.compileAsync=function(M,P,H=null){let O=this.compile(M,P,H);return new Promise(N=>{function he(){if(O.forEach(function(xe){k.get(xe).currentProgram.isReady()&&O.delete(xe)}),O.size===0){N(M);return}setTimeout(he,10)}nt.get("KHR_parallel_shader_compile")!==null?he():setTimeout(he,10)})};let Gd=null;function JM(M){Gd&&Gd(M)}function $g(){Ms.stop()}function ex(){Ms.start()}let Ms=new Q0;Ms.setAnimationLoop(JM),typeof self<"u"&&Ms.setContext(self),this.setAnimationLoop=function(M){Gd=M,ye.setAnimationLoop(M),M===null?Ms.stop():Ms.start()},ye.addEventListener("sessionstart",$g),ye.addEventListener("sessionend",ex),this.render=function(M,P){if(P!==void 0&&P.isCamera!==!0){Ee("WebGLRenderer.render: camera is not an instance of THREE.Camera.");return}if(w===!0)return;B!==null&&B.renderStart(M,P);let H=ye.enabled===!0&&ye.isPresenting===!0,O=A!==null&&(j===null||H)&&A.begin(E,j);if(M.matrixWorldAutoUpdate===!0&&M.updateMatrixWorld(),P.parent===null&&P.matrixWorldAutoUpdate===!0&&P.updateMatrixWorld(),ye.enabled===!0&&ye.isPresenting===!0&&(A===null||A.isCompositing()===!1)&&(ye.cameraAutoUpdate===!0&&ye.updateCamera(P),P=ye.getCamera()),M.isScene===!0&&M.onBeforeRender(E,M,P,j),C=oe.get(M,y.length),C.init(P),C.state.textureUnits=G.getTextureUnits(),y.push(C),zt.multiplyMatrices(P.projectionMatrix,P.matrixWorldInverse),ut.setFromProjectionMatrix(zt,xn,P.reversedDepth),Ze=this.localClippingEnabled,$e=Le.init(this.clippingPlanes,Ze),L=ue.get(M,T.length),L.init(),T.push(L),ye.enabled===!0&&ye.isPresenting===!0){let xe=E.xr.getDepthSensingMesh();xe!==null&&qd(xe,P,-1/0,E.sortObjects)}qd(M,P,0,E.sortObjects),L.finish(),E.sortObjects===!0&&L.sort(Re,Ue,P.reversedDepth),It=ye.enabled===!1||ye.isPresenting===!1||ye.hasDepthSensing()===!1,It&&Be.addToRenderList(L,M),this.info.render.frame++,this.info.autoReset===!0&&this.info.reset(),$e===!0&&Le.beginShadows();let N=C.state.shadowsArray;if(Ie.render(N,M,P),$e===!0&&Le.endShadows(),(O&&A.hasRenderPass())===!1){let xe=L.opaque,de=L.transmissive;if(C.setupLights(),P.isArrayCamera){let _e=P.cameras;if(de.length>0)for(let be=0,Oe=_e.length;be<Oe;be++){let ze=_e[be];ax(xe,de,M,ze)}It&&Be.render(M);for(let be=0,Oe=_e.length;be<Oe;be++){let ze=_e[be];tx(L,M,ze,ze.viewport)}}else de.length>0&&ax(xe,de,M,P),It&&Be.render(M),tx(L,M,P)}j!==null&&V===0&&(G.updateMultisampleRenderTarget(j),G.updateRenderTargetMipmap(j)),O&&A.end(E),M.isScene===!0&&M.onAfterRender(E,M,P),pe.resetDefaultState(),ee=-1,fe=null,y.pop(),y.length>0?(C=y[y.length-1],G.setTextureUnits(C.state.textureUnits),$e===!0&&Le.setGlobalState(E.clippingPlanes,C.state.camera)):C=null,T.pop(),T.length>0?L=T[T.length-1]:L=null,B!==null&&B.renderEnd()};function qd(M,P,H,O){if(M.visible===!1)return;if(M.layers.test(P.layers)){if(M.isGroup)H=M.renderOrder;else if(M.isLOD)M.autoUpdate===!0&&M.update(P);else if(M.isLightProbeGrid)C.pushLightProbeGrid(M);else if(M.isLight)C.pushLight(M),M.castShadow&&C.pushShadow(M);else if(M.isSprite){if(!M.frustumCulled||ut.intersectsSprite(M)){O&&Qt.setFromMatrixPosition(M.matrixWorld).applyMatrix4(zt);let xe=Z.update(M),de=M.material;de.visible&&L.push(M,xe,de,H,Qt.z,null)}}else if((M.isMesh||M.isLine||M.isPoints)&&(!M.frustumCulled||ut.intersectsObject(M))){let xe=Z.update(M),de=M.material;if(O&&(M.boundingSphere!==void 0?(M.boundingSphere===null&&M.computeBoundingSphere(),Qt.copy(M.boundingSphere.center)):(xe.boundingSphere===null&&xe.computeBoundingSphere(),Qt.copy(xe.boundingSphere.center)),Qt.applyMatrix4(M.matrixWorld).applyMatrix4(zt)),Array.isArray(de)){let _e=xe.groups;for(let be=0,Oe=_e.length;be<Oe;be++){let ze=_e[be],Ce=de[ze.materialIndex];Ce&&Ce.visible&&L.push(M,xe,Ce,H,Qt.z,ze)}}else de.visible&&L.push(M,xe,de,H,Qt.z,null)}}let he=M.children;for(let xe=0,de=he.length;xe<de;xe++)qd(he[xe],P,H,O)}function tx(M,P,H,O){let{opaque:N,transmissive:he,transparent:xe}=M;C.setupLightsView(H),$e===!0&&Le.setGlobalState(E.clippingPlanes,H),O&&g.viewport(me.copy(O)),N.length>0&&uu(N,P,H),he.length>0&&uu(he,P,H),xe.length>0&&uu(xe,P,H),g.buffers.depth.setTest(!0),g.buffers.depth.setMask(!0),g.buffers.color.setMask(!0),g.setPolygonOffset(!1)}function ax(M,P,H,O){if((H.isScene===!0?H.overrideMaterial:null)!==null)return;if(C.state.transmissionRenderTarget[O.id]===void 0){let Ce=nt.has("EXT_color_buffer_half_float")||nt.has("EXT_color_buffer_float");C.state.transmissionRenderTarget[O.id]=new Fa(1,1,{generateMipmaps:!0,type:Ce?Fn:ka,minFilter:qi,samples:Math.max(4,I.samples),stencilBuffer:s,resolveDepthBuffer:!1,resolveStencilBuffer:!1,colorSpace:Ge.workingColorSpace})}let he=C.state.transmissionRenderTarget[O.id],xe=O.viewport||me;he.setSize(xe.z*E.transmissionResolutionScale,xe.w*E.transmissionResolutionScale);let de=E.getRenderTarget(),_e=E.getActiveCubeFace(),be=E.getActiveMipmapLevel();E.setRenderTarget(he),E.getClearColor(Tt),je=E.getClearAlpha(),je<1&&E.setClearColor(16777215,.5),E.clear(),It&&Be.render(H);let Oe=E.toneMapping;E.toneMapping=vn;let ze=O.viewport;if(O.viewport!==void 0&&(O.viewport=void 0),C.setupLightsView(O),$e===!0&&Le.setGlobalState(E.clippingPlanes,O),uu(M,H,O),G.updateMultisampleRenderTarget(he),G.updateRenderTargetMipmap(he),nt.has("WEBGL_multisampled_render_to_texture")===!1){let Ce=!1;for(let rt=0,Ut=P.length;rt<Ut;rt++){let wt=P[rt],{object:ct,geometry:ca,material:ge,group:Pa}=wt;if(ge.side===On&&ct.layers.test(O.layers)){let Ke=ge.side;ge.side=va,ge.needsUpdate=!0,nx(ct,H,O,ca,ge,Pa),ge.side=Ke,ge.needsUpdate=!0,Ce=!0}}Ce===!0&&(G.updateMultisampleRenderTarget(he),G.updateRenderTargetMipmap(he))}E.setRenderTarget(de,_e,be),E.setClearColor(Tt,je),ze!==void 0&&(O.viewport=ze),E.toneMapping=Oe}function uu(M,P,H){let O=P.isScene===!0?P.overrideMaterial:null;for(let N=0,he=M.length;N<he;N++){let xe=M[N],{object:de,geometry:_e,group:be}=xe,Oe=xe.material;Oe.allowOverride===!0&&O!==null&&(Oe=O),de.layers.test(H.layers)&&nx(de,P,H,_e,Oe,be)}}function nx(M,P,H,O,N,he){M.onBeforeRender(E,P,H,O,N,he),M.modelViewMatrix.multiplyMatrices(H.matrixWorldInverse,M.matrixWorld),M.normalMatrix.getNormalMatrix(M.modelViewMatrix),N.onBeforeRender(E,P,H,O,M,he),N.transparent===!0&&N.side===On&&N.forceSinglePass===!1?(N.side=va,N.needsUpdate=!0,E.renderBufferDirect(H,P,O,N,M,he),N.side=ai,N.needsUpdate=!0,E.renderBufferDirect(H,P,O,N,M,he),N.side=On):E.renderBufferDirect(H,P,O,N,M,he),M.onAfterRender(E,P,H,O,N,he)}function cu(M,P,H){P.isScene!==!0&&(P=na);let O=k.get(M),N=C.state.lights,he=C.state.shadowsArray,xe=N.state.version,de=re.getParameters(M,N.state,he,P,H,C.state.lightProbeGridArray),_e=re.getProgramCacheKey(de),be=O.programs;O.environment=M.isMeshStandardMaterial||M.isMeshLambertMaterial||M.isMeshPhongMaterial?P.environment:null,O.fog=P.fog;let Oe=M.isMeshStandardMaterial||M.isMeshLambertMaterial&&!M.envMap||M.isMeshPhongMaterial&&!M.envMap;O.envMap=ae.get(M.envMap||O.environment,Oe),O.envMapRotation=O.environment!==null&&M.envMap===null?P.environmentRotation:M.envMapRotation,be===void 0&&(M.addEventListener("dispose",An),be=new Map,O.programs=be);let ze=be.get(_e);if(ze!==void 0){if(O.currentProgram===ze&&O.lightsStateVersion===xe)return sx(M,de),ze}else de.uniforms=re.getUniforms(M),B!==null&&M.isNodeMaterial&&B.build(M,H,de),M.onBeforeCompile(de,E),ze=re.acquireProgram(de,_e),be.set(_e,ze),O.uniforms=de.uniforms;let Ce=O.uniforms;return(!M.isShaderMaterial&&!M.isRawShaderMaterial||M.clipping===!0)&&(Ce.clippingPlanes=Le.uniform),sx(M,de),O.needsLights=eb(M),O.lightsStateVersion=xe,O.needsLights&&(Ce.ambientLightColor.value=N.state.ambient,Ce.lightProbe.value=N.state.probe,Ce.directionalLights.value=N.state.directional,Ce.directionalLightShadows.value=N.state.directionalShadow,Ce.spotLights.value=N.state.spot,Ce.spotLightShadows.value=N.state.spotShadow,Ce.rectAreaLights.value=N.state.rectArea,Ce.ltc_1.value=N.state.rectAreaLTC1,Ce.ltc_2.value=N.state.rectAreaLTC2,Ce.pointLights.value=N.state.point,Ce.pointLightShadows.value=N.state.pointShadow,Ce.hemisphereLights.value=N.state.hemi,Ce.directionalShadowMatrix.value=N.state.directionalShadowMatrix,Ce.spotLightMatrix.value=N.state.spotLightMatrix,Ce.spotLightMap.value=N.state.spotLightMap,Ce.pointShadowMatrix.value=N.state.pointShadowMatrix),O.lightProbeGrid=C.state.lightProbeGridArray.length>0,O.currentProgram=ze,O.uniformsList=null,ze}function ix(M){if(M.uniformsList===null){let P=M.currentProgram.getUniforms();M.uniformsList=wr.seqWithValue(P.seq,M.uniforms)}return M.uniformsList}function sx(M,P){let H=k.get(M);H.outputColorSpace=P.outputColorSpace,H.batching=P.batching,H.batchingColor=P.batchingColor,H.instancing=P.instancing,H.instancingColor=P.instancingColor,H.instancingMorph=P.instancingMorph,H.skinning=P.skinning,H.morphTargets=P.morphTargets,H.morphNormals=P.morphNormals,H.morphColors=P.morphColors,H.morphTargetsCount=P.morphTargetsCount,H.numClippingPlanes=P.numClippingPlanes,H.numIntersection=P.numClipIntersection,H.vertexAlphas=P.vertexAlphas,H.vertexTangents=P.vertexTangents,H.toneMapping=P.toneMapping}function QM(M,P){if(M.length===0)return null;if(M.length===1)return M[0].texture!==null?M[0]:null;_.setFromMatrixPosition(P.matrixWorld);for(let H=0,O=M.length;H<O;H++){let N=M[H];if(N.texture!==null&&N.boundingBox.containsPoint(_))return N}return null}function jM(M,P,H,O,N){P.isScene!==!0&&(P=na),G.resetTextureUnits();let he=P.fog,xe=O.isMeshStandardMaterial||O.isMeshLambertMaterial||O.isMeshPhongMaterial?P.environment:null,de=j===null?E.outputColorSpace:j.isXRRenderTarget===!0?j.texture.colorSpace:Ge.workingColorSpace,_e=O.isMeshStandardMaterial||O.isMeshLambertMaterial&&!O.envMap||O.isMeshPhongMaterial&&!O.envMap,be=ae.get(O.envMap||xe,_e),Oe=O.vertexColors===!0&&!!H.attributes.color&&H.attributes.color.itemSize===4,ze=!!H.attributes.tangent&&(!!O.normalMap||O.anisotropy>0),Ce=!!H.morphAttributes.position,rt=!!H.morphAttributes.normal,Ut=!!H.morphAttributes.color,wt=vn;O.toneMapped&&(j===null||j.isXRRenderTarget===!0)&&(wt=E.toneMapping);let ct=H.morphAttributes.position||H.morphAttributes.normal||H.morphAttributes.color,ca=ct!==void 0?ct.length:0,ge=k.get(O),Pa=C.state.lights;if($e===!0&&(Ze===!0||M!==fe)){let pt=M===fe&&O.id===ee;Le.setState(O,M,pt)}let Ke=!1;O.version===ge.__version?(ge.needsLights&&ge.lightsStateVersion!==Pa.state.version||ge.outputColorSpace!==de||N.isBatchedMesh&&ge.batching===!1||!N.isBatchedMesh&&ge.batching===!0||N.isBatchedMesh&&ge.batchingColor===!0&&N.colorTexture===null||N.isBatchedMesh&&ge.batchingColor===!1&&N.colorTexture!==null||N.isInstancedMesh&&ge.instancing===!1||!N.isInstancedMesh&&ge.instancing===!0||N.isSkinnedMesh&&ge.skinning===!1||!N.isSkinnedMesh&&ge.skinning===!0||N.isInstancedMesh&&ge.instancingColor===!0&&N.instanceColor===null||N.isInstancedMesh&&ge.instancingColor===!1&&N.instanceColor!==null||N.isInstancedMesh&&ge.instancingMorph===!0&&N.morphTexture===null||N.isInstancedMesh&&ge.instancingMorph===!1&&N.morphTexture!==null||ge.envMap!==be||O.fog===!0&&ge.fog!==he||ge.numClippingPlanes!==void 0&&(ge.numClippingPlanes!==Le.numPlanes||ge.numIntersection!==Le.numIntersection)||ge.vertexAlphas!==Oe||ge.vertexTangents!==ze||ge.morphTargets!==Ce||ge.morphNormals!==rt||ge.morphColors!==Ut||ge.toneMapping!==wt||ge.morphTargetsCount!==ca||!!ge.lightProbeGrid!=C.state.lightProbeGridArray.length>0)&&(Ke=!0):(Ke=!0,ge.__version=O.version);let Qa=ge.currentProgram;Ke===!0&&(Qa=cu(O,P,N),B&&O.isNodeMaterial&&B.onUpdateProgram(O,Qa,ge));let Tn=!1,Li=!1,ir=!1,ft=Qa.getUniforms(),Bt=ge.uniforms;if(g.useProgram(Qa.program)&&(Tn=!0,Li=!0,ir=!0),O.id!==ee&&(ee=O.id,Li=!0),ge.needsLights){let pt=QM(C.state.lightProbeGridArray,N);ge.lightProbeGrid!==pt&&(ge.lightProbeGrid=pt,Li=!0)}if(Tn||fe!==M){g.buffers.depth.getReversed()&&M.reversedDepth!==!0&&(M._reversedDepth=!0,M.updateProjectionMatrix()),ft.setValue(D,"projectionMatrix",M.projectionMatrix),ft.setValue(D,"viewMatrix",M.matrixWorldInverse);let Ti=ft.map.cameraPosition;Ti!==void 0&&Ti.setValue(D,Xt.setFromMatrixPosition(M.matrixWorld)),I.logarithmicDepthBuffer&&ft.setValue(D,"logDepthBufFC",2/(Math.log(M.far+1)/Math.LN2)),(O.isMeshPhongMaterial||O.isMeshToonMaterial||O.isMeshLambertMaterial||O.isMeshBasicMaterial||O.isMeshStandardMaterial||O.isShaderMaterial)&&ft.setValue(D,"isOrthographic",M.isOrthographicCamera===!0),fe!==M&&(fe=M,Li=!0,ir=!0)}if(ge.needsLights&&(Pa.state.directionalShadowMap.length>0&&ft.setValue(D,"directionalShadowMap",Pa.state.directionalShadowMap,G),Pa.state.spotShadowMap.length>0&&ft.setValue(D,"spotShadowMap",Pa.state.spotShadowMap,G),Pa.state.pointShadowMap.length>0&&ft.setValue(D,"pointShadowMap",Pa.state.pointShadowMap,G)),N.isSkinnedMesh){ft.setOptional(D,N,"bindMatrix"),ft.setOptional(D,N,"bindMatrixInverse");let pt=N.skeleton;pt&&(pt.boneTexture===null&&pt.computeBoneTexture(),ft.setValue(D,"boneTexture",pt.boneTexture,G))}N.isBatchedMesh&&(ft.setOptional(D,N,"batchingTexture"),ft.setValue(D,"batchingTexture",N._matricesTexture,G),ft.setOptional(D,N,"batchingIdTexture"),ft.setValue(D,"batchingIdTexture",N._indirectTexture,G),ft.setOptional(D,N,"batchingColorTexture"),N._colorsTexture!==null&&ft.setValue(D,"batchingColorTexture",N._colorsTexture,G));let Ai=H.morphAttributes;if((Ai.position!==void 0||Ai.normal!==void 0||Ai.color!==void 0)&&R.update(N,H,Qa),(Li||ge.receiveShadow!==N.receiveShadow)&&(ge.receiveShadow=N.receiveShadow,ft.setValue(D,"receiveShadow",N.receiveShadow)),(O.isMeshStandardMaterial||O.isMeshLambertMaterial||O.isMeshPhongMaterial)&&O.envMap===null&&P.environment!==null&&(Bt.envMapIntensity.value=P.environmentIntensity),Bt.dfgLUT!==void 0&&(Bt.dfgLUT.value=YT()),Li){if(ft.setValue(D,"toneMappingExposure",E.toneMappingExposure),ge.needsLights&&$M(Bt,ir),he&&O.fog===!0&&Me.refreshFogUniforms(Bt,he),Me.refreshMaterialUniforms(Bt,O,te,ie,C.state.transmissionRenderTarget[M.id]),ge.needsLights&&ge.lightProbeGrid){let pt=ge.lightProbeGrid;Bt.probesSH.value=pt.texture,Bt.probesMin.value.copy(pt.boundingBox.min),Bt.probesMax.value.copy(pt.boundingBox.max),Bt.probesResolution.value.copy(pt.resolution)}wr.upload(D,ix(ge),Bt,G)}if(O.isShaderMaterial&&O.uniformsNeedUpdate===!0&&(wr.upload(D,ix(ge),Bt,G),O.uniformsNeedUpdate=!1),O.isSpriteMaterial&&ft.setValue(D,"center",N.center),ft.setValue(D,"modelViewMatrix",N.modelViewMatrix),ft.setValue(D,"normalMatrix",N.normalMatrix),ft.setValue(D,"modelMatrix",N.matrixWorld),O.uniformsGroups!==void 0){let pt=O.uniformsGroups;for(let Ti=0,sr=pt.length;Ti<sr;Ti++){let rx=pt[Ti];$.update(rx,Qa),$.bind(rx,Qa)}}return Qa}function $M(M,P){M.ambientLightColor.needsUpdate=P,M.lightProbe.needsUpdate=P,M.directionalLights.needsUpdate=P,M.directionalLightShadows.needsUpdate=P,M.pointLights.needsUpdate=P,M.pointLightShadows.needsUpdate=P,M.spotLights.needsUpdate=P,M.spotLightShadows.needsUpdate=P,M.rectAreaLights.needsUpdate=P,M.hemisphereLights.needsUpdate=P}function eb(M){return M.isMeshLambertMaterial||M.isMeshToonMaterial||M.isMeshPhongMaterial||M.isMeshStandardMaterial||M.isShadowMaterial||M.isShaderMaterial&&M.lights===!0}this.getActiveCubeFace=function(){return W},this.getActiveMipmapLevel=function(){return V},this.getRenderTarget=function(){return j},this.setRenderTargetTextures=function(M,P,H){let O=k.get(M);O.__autoAllocateDepthBuffer=M.resolveDepthBuffer===!1,O.__autoAllocateDepthBuffer===!1&&(O.__useRenderToTexture=!1),k.get(M.texture).__webglTexture=P,k.get(M.depthTexture).__webglTexture=O.__autoAllocateDepthBuffer?void 0:H,O.__hasExternalTextures=!0},this.setRenderTargetFramebuffer=function(M,P){let H=k.get(M);H.__webglFramebuffer=P,H.__useDefaultFramebuffer=P===void 0},this.setRenderTarget=function(M,P=0,H=0){j=M,W=P,V=H;let O=null,N=!1,he=!1;if(M){let de=k.get(M);if(de.__useDefaultFramebuffer!==void 0){g.bindFramebuffer(D.FRAMEBUFFER,de.__webglFramebuffer),me.copy(M.viewport),ve.copy(M.scissor),Qe=M.scissorTest,g.viewport(me),g.scissor(ve),g.setScissorTest(Qe),ee=-1;return}else if(de.__webglFramebuffer===void 0)G.setupRenderTarget(M);else if(de.__hasExternalTextures)G.rebindTextures(M,k.get(M.texture).__webglTexture,k.get(M.depthTexture).__webglTexture);else if(M.depthBuffer){let Oe=M.depthTexture;if(de.__boundDepthTexture!==Oe){if(Oe!==null&&k.has(Oe)&&(M.width!==Oe.image.width||M.height!==Oe.image.height))throw new Error("THREE.WebGLRenderer: Attached DepthTexture is initialized to the incorrect size.");G.setupDepthRenderbuffer(M)}}let _e=M.texture;(_e.isData3DTexture||_e.isDataArrayTexture||_e.isCompressedArrayTexture)&&(he=!0);let be=k.get(M).__webglFramebuffer;M.isWebGLCubeRenderTarget?(Array.isArray(be[P])?O=be[P][H]:O=be[P],N=!0):M.samples>0&&G.useMultisampledRTT(M)===!1?O=k.get(M).__webglMultisampledFramebuffer:Array.isArray(be)?O=be[H]:O=be,me.copy(M.viewport),ve.copy(M.scissor),Qe=M.scissorTest}else me.copy(Te).multiplyScalar(te).floor(),ve.copy(Pt).multiplyScalar(te).floor(),Qe=Ve;if(H!==0&&(O=X),g.bindFramebuffer(D.FRAMEBUFFER,O)&&g.drawBuffers(M,O),g.viewport(me),g.scissor(ve),g.setScissorTest(Qe),N){let de=k.get(M.texture);D.framebufferTexture2D(D.FRAMEBUFFER,D.COLOR_ATTACHMENT0,D.TEXTURE_CUBE_MAP_POSITIVE_X+P,de.__webglTexture,H)}else if(he){let de=P;for(let _e=0;_e<M.textures.length;_e++){let be=k.get(M.textures[_e]);D.framebufferTextureLayer(D.FRAMEBUFFER,D.COLOR_ATTACHMENT0+_e,be.__webglTexture,H,de)}}else if(M!==null&&H!==0){let de=k.get(M.texture);D.framebufferTexture2D(D.FRAMEBUFFER,D.COLOR_ATTACHMENT0,D.TEXTURE_2D,de.__webglTexture,H)}ee=-1},this.readRenderTargetPixels=function(M,P,H,O,N,he,xe,de=0){if(!(M&&M.isWebGLRenderTarget)){Ee("WebGLRenderer.readRenderTargetPixels: renderTarget is not THREE.WebGLRenderTarget.");return}let _e=k.get(M).__webglFramebuffer;if(M.isWebGLCubeRenderTarget&&xe!==void 0&&(_e=_e[xe]),_e){g.bindFramebuffer(D.FRAMEBUFFER,_e);try{let be=M.textures[de],Oe=be.format,ze=be.type;if(M.textures.length>1&&D.readBuffer(D.COLOR_ATTACHMENT0+de),!I.textureFormatReadable(Oe)){Ee("WebGLRenderer.readRenderTargetPixels: renderTarget is not in RGBA or implementation defined format.");return}if(!I.textureTypeReadable(ze)){Ee("WebGLRenderer.readRenderTargetPixels: renderTarget is not in UnsignedByteType or implementation defined type.");return}P>=0&&P<=M.width-O&&H>=0&&H<=M.height-N&&D.readPixels(P,H,O,N,le.convert(Oe),le.convert(ze),he)}finally{let be=j!==null?k.get(j).__webglFramebuffer:null;g.bindFramebuffer(D.FRAMEBUFFER,be)}}},this.readRenderTargetPixelsAsync=async function(M,P,H,O,N,he,xe,de=0){if(!(M&&M.isWebGLRenderTarget))throw new Error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not THREE.WebGLRenderTarget.");let _e=k.get(M).__webglFramebuffer;if(M.isWebGLCubeRenderTarget&&xe!==void 0&&(_e=_e[xe]),_e)if(P>=0&&P<=M.width-O&&H>=0&&H<=M.height-N){g.bindFramebuffer(D.FRAMEBUFFER,_e);let be=M.textures[de],Oe=be.format,ze=be.type;if(M.textures.length>1&&D.readBuffer(D.COLOR_ATTACHMENT0+de),!I.textureFormatReadable(Oe))throw new Error("THREE.WebGLRenderer.readRenderTargetPixelsAsync: renderTarget is not in RGBA or implementation defined format.");if(!I.textureTypeReadable(ze))throw new Error("THREE.WebGLRenderer.readRenderTargetPixelsAsync: renderTarget is not in UnsignedByteType or implementation defined type.");let Ce=D.createBuffer();D.bindBuffer(D.PIXEL_PACK_BUFFER,Ce),D.bufferData(D.PIXEL_PACK_BUFFER,he.byteLength,D.STREAM_READ),D.readPixels(P,H,O,N,le.convert(Oe),le.convert(ze),0);let rt=j!==null?k.get(j).__webglFramebuffer:null;g.bindFramebuffer(D.FRAMEBUFFER,rt);let Ut=D.fenceSync(D.SYNC_GPU_COMMANDS_COMPLETE,0);return D.flush(),await C0(D,Ut,4),D.bindBuffer(D.PIXEL_PACK_BUFFER,Ce),D.getBufferSubData(D.PIXEL_PACK_BUFFER,0,he),D.deleteBuffer(Ce),D.deleteSync(Ut),he}else throw new Error("THREE.WebGLRenderer.readRenderTargetPixelsAsync: requested read bounds are out of range.")},this.copyFramebufferToTexture=function(M,P=null,H=0){let O=Math.pow(2,-H),N=Math.floor(M.image.width*O),he=Math.floor(M.image.height*O),xe=P!==null?P.x:0,de=P!==null?P.y:0;G.setTexture2D(M,0),D.copyTexSubImage2D(D.TEXTURE_2D,H,0,0,xe,de,N,he),g.unbindTexture()},this.copyTextureToTexture=function(M,P,H=null,O=null,N=0,he=0){let xe,de,_e,be,Oe,ze,Ce,rt,Ut,wt=M.isCompressedTexture?M.mipmaps[he]:M.image;if(H!==null)xe=H.max.x-H.min.x,de=H.max.y-H.min.y,_e=H.isBox3?H.max.z-H.min.z:1,be=H.min.x,Oe=H.min.y,ze=H.isBox3?H.min.z:0;else{let Bt=Math.pow(2,-N);xe=Math.floor(wt.width*Bt),de=Math.floor(wt.height*Bt),M.isDataArrayTexture?_e=wt.depth:M.isData3DTexture?_e=Math.floor(wt.depth*Bt):_e=1,be=0,Oe=0,ze=0}O!==null?(Ce=O.x,rt=O.y,Ut=O.z):(Ce=0,rt=0,Ut=0);let ct=le.convert(P.format),ca=le.convert(P.type),ge;P.isData3DTexture?(G.setTexture3D(P,0),ge=D.TEXTURE_3D):P.isDataArrayTexture||P.isCompressedArrayTexture?(G.setTexture2DArray(P,0),ge=D.TEXTURE_2D_ARRAY):(G.setTexture2D(P,0),ge=D.TEXTURE_2D),g.activeTexture(D.TEXTURE0),g.pixelStorei(D.UNPACK_FLIP_Y_WEBGL,P.flipY),g.pixelStorei(D.UNPACK_PREMULTIPLY_ALPHA_WEBGL,P.premultiplyAlpha),g.pixelStorei(D.UNPACK_ALIGNMENT,P.unpackAlignment);let Pa=g.getParameter(D.UNPACK_ROW_LENGTH),Ke=g.getParameter(D.UNPACK_IMAGE_HEIGHT),Qa=g.getParameter(D.UNPACK_SKIP_PIXELS),Tn=g.getParameter(D.UNPACK_SKIP_ROWS),Li=g.getParameter(D.UNPACK_SKIP_IMAGES);g.pixelStorei(D.UNPACK_ROW_LENGTH,wt.width),g.pixelStorei(D.UNPACK_IMAGE_HEIGHT,wt.height),g.pixelStorei(D.UNPACK_SKIP_PIXELS,be),g.pixelStorei(D.UNPACK_SKIP_ROWS,Oe),g.pixelStorei(D.UNPACK_SKIP_IMAGES,ze);let ir=M.isDataArrayTexture||M.isData3DTexture,ft=P.isDataArrayTexture||P.isData3DTexture;if(M.isDepthTexture){let Bt=k.get(M),Ai=k.get(P),pt=k.get(Bt.__renderTarget),Ti=k.get(Ai.__renderTarget);g.bindFramebuffer(D.READ_FRAMEBUFFER,pt.__webglFramebuffer),g.bindFramebuffer(D.DRAW_FRAMEBUFFER,Ti.__webglFramebuffer);for(let sr=0;sr<_e;sr++)ir&&(D.framebufferTextureLayer(D.READ_FRAMEBUFFER,D.COLOR_ATTACHMENT0,k.get(M).__webglTexture,N,ze+sr),D.framebufferTextureLayer(D.DRAW_FRAMEBUFFER,D.COLOR_ATTACHMENT0,k.get(P).__webglTexture,he,Ut+sr)),D.blitFramebuffer(be,Oe,xe,de,Ce,rt,xe,de,D.DEPTH_BUFFER_BIT,D.NEAREST);g.bindFramebuffer(D.READ_FRAMEBUFFER,null),g.bindFramebuffer(D.DRAW_FRAMEBUFFER,null)}else if(N!==0||M.isRenderTargetTexture||k.has(M)){let Bt=k.get(M),Ai=k.get(P);g.bindFramebuffer(D.READ_FRAMEBUFFER,K),g.bindFramebuffer(D.DRAW_FRAMEBUFFER,z);for(let pt=0;pt<_e;pt++)ir?D.framebufferTextureLayer(D.READ_FRAMEBUFFER,D.COLOR_ATTACHMENT0,Bt.__webglTexture,N,ze+pt):D.framebufferTexture2D(D.READ_FRAMEBUFFER,D.COLOR_ATTACHMENT0,D.TEXTURE_2D,Bt.__webglTexture,N),ft?D.framebufferTextureLayer(D.DRAW_FRAMEBUFFER,D.COLOR_ATTACHMENT0,Ai.__webglTexture,he,Ut+pt):D.framebufferTexture2D(D.DRAW_FRAMEBUFFER,D.COLOR_ATTACHMENT0,D.TEXTURE_2D,Ai.__webglTexture,he),N!==0?D.blitFramebuffer(be,Oe,xe,de,Ce,rt,xe,de,D.COLOR_BUFFER_BIT,D.NEAREST):ft?D.copyTexSubImage3D(ge,he,Ce,rt,Ut+pt,be,Oe,xe,de):D.copyTexSubImage2D(ge,he,Ce,rt,be,Oe,xe,de);g.bindFramebuffer(D.READ_FRAMEBUFFER,null),g.bindFramebuffer(D.DRAW_FRAMEBUFFER,null)}else ft?M.isDataTexture||M.isData3DTexture?D.texSubImage3D(ge,he,Ce,rt,Ut,xe,de,_e,ct,ca,wt.data):P.isCompressedArrayTexture?D.compressedTexSubImage3D(ge,he,Ce,rt,Ut,xe,de,_e,ct,wt.data):D.texSubImage3D(ge,he,Ce,rt,Ut,xe,de,_e,ct,ca,wt):M.isDataTexture?D.texSubImage2D(D.TEXTURE_2D,he,Ce,rt,xe,de,ct,ca,wt.data):M.isCompressedTexture?D.compressedTexSubImage2D(D.TEXTURE_2D,he,Ce,rt,wt.width,wt.height,ct,wt.data):D.texSubImage2D(D.TEXTURE_2D,he,Ce,rt,xe,de,ct,ca,wt);g.pixelStorei(D.UNPACK_ROW_LENGTH,Pa),g.pixelStorei(D.UNPACK_IMAGE_HEIGHT,Ke),g.pixelStorei(D.UNPACK_SKIP_PIXELS,Qa),g.pixelStorei(D.UNPACK_SKIP_ROWS,Tn),g.pixelStorei(D.UNPACK_SKIP_IMAGES,Li),he===0&&P.generateMipmaps&&D.generateMipmap(ge),g.unbindTexture()},this.initRenderTarget=function(M){k.get(M).__webglFramebuffer===void 0&&G.setupRenderTarget(M)},this.initTexture=function(M){M.isCubeTexture?G.setTextureCube(M,0):M.isData3DTexture?G.setTexture3D(M,0):M.isDataArrayTexture||M.isCompressedArrayTexture?G.setTexture2DArray(M,0):G.setTexture2D(M,0),g.unbindTexture()},this.resetState=function(){W=0,V=0,j=null,g.reset(),pe.reset()},typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}get coordinateSystem(){return xn}get outputColorSpace(){return this._outputColorSpace}set outputColorSpace(e){this._outputColorSpace=e;let a=this.getContext();a.drawingBufferColorSpace=Ge._getDrawingBufferColorSpace(e),a.unpackColorSpace=Ge._getUnpackColorSpace()}};var iv={canvas:{kfzvcC:"x47corl",kVAEAm:"x10l6tqk",kpwlN0:"x10a8y8t",kzqmXN:"xh8yej3",kZKoxP:"x5yr21d",$$css:!0}};var uv=Ua(Ns(),1),QT=`
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`,jT=`
  precision highp float;

  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec2 uPointer;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), f.x),
      f.y
    );
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.52;
    mat2 rotation = mat2(0.80, 0.60, -0.60, 0.80);
    for (int i = 0; i < 5; i++) {
      value += amplitude * noise(p);
      p = rotation * p * 2.03 + 9.7;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vec2 uv = vUv;
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
    p += uPointer * vec2(0.12, 0.06);

    vec2 farDrift = vec2(uTime * 0.028, uTime * 0.006);
    vec2 nearDrift = vec2(-uTime * 0.045, uTime * 0.009);

    float farShape = fbm(p * 2.15 + farDrift);
    float farDetail = fbm(p * 5.2 - farDrift * 0.7 + farShape);
    float farCloud = smoothstep(0.54, 0.73, farShape * 0.72 + farDetail * 0.42);

    float nearShape = fbm((p + vec2(0.7, -0.28)) * 1.55 + nearDrift);
    float nearDetail = fbm(p * 3.7 - nearDrift * 0.55 + nearShape * 1.3);
    float nearCloud = smoothstep(0.55, 0.76, nearShape * 0.76 + nearDetail * 0.40);

    float lowerBank = 1.0 - smoothstep(0.13, 0.68, uv.y);
    float upperWisps = smoothstep(0.56, 0.98, uv.y) * 0.56;
    float sideBanks = smoothstep(0.28, 0.98, abs(uv.x - 0.5) * 2.0) * 0.5;
    float cloudMask = clamp(lowerBank + upperWisps + sideBanks, 0.0, 1.0);

    float cloud = clamp(farCloud * 0.65 + nearCloud * 0.92, 0.0, 1.0) * cloudMask;
    float softHaze = fbm(p * 1.1 + farDrift * 0.4) * lowerBank * 0.13;
    vec3 shadowColor = vec3(0.22, 0.24, 0.25);
    vec3 lightColor = vec3(0.93, 0.94, 0.94);
    vec3 cloudColor = mix(shadowColor, lightColor, smoothstep(0.16, 0.82, cloud));
    float alpha = cloud * 0.72 + softHaze;

    gl_FragColor = vec4(cloudColor, alpha);
  }
`;function lv(){let t=(0,df.useRef)(null);return(0,df.useEffect)(()=>{let e=t.current;if(!e||typeof WebGLRenderingContext>"u")return;let a;try{a=new lf({canvas:e,alpha:!0,antialias:!1,powerPreference:"low-power"})}catch{return}a.setPixelRatio(Math.min(window.devicePixelRatio,1.35)),a.outputColorSpace=ga,a.setClearColor(329223,0);let n=new Fo,i=new ha(38,1,.1,160);i.position.set(0,1.2,17);let s=new Ps(34,19),r={uTime:{value:0},uResolution:{value:new qe(1,1)},uPointer:{value:new qe(0,0)}},o=new xa({vertexShader:QT,fragmentShader:jT,uniforms:r,transparent:!0,depthWrite:!1,depthTest:!1}),l=new La(s,o);l.position.set(0,.2,0),n.add(l);let u=()=>{let{clientWidth:m,clientHeight:f}=e;!m||!f||(a.setSize(m,f,!1),r.uResolution.value.set(m,f),i.aspect=m/f,i.updateProjectionMatrix())},d=new ResizeObserver(u);d.observe(e),u();let p=window.matchMedia("(prefers-reduced-motion: reduce)").matches,c=new qe,h=m=>{c.set(m.clientX/Math.max(window.innerWidth,1)-.5,m.clientY/Math.max(window.innerHeight,1)-.5)};window.addEventListener("pointermove",h,{passive:!0});let v=new Zo,b=()=>{let m=v.getElapsedTime();p||(r.uTime.value=m,r.uPointer.value.lerp(c,.018),i.position.z=17+Math.min(m,2.4)*.12),a.render(n,i)};return a.setAnimationLoop(p?null:b),b(),()=>{d.disconnect(),window.removeEventListener("pointermove",h),a.setAnimationLoop(null),s.dispose(),o.dispose(),a.dispose()}},[]),(0,uv.jsx)("canvas",{ref:t,"aria-hidden":"true","data-testid":"app-switcher-three-sky",...bt(iv.canvas)})}function Dr(t,e,a){let n=e?t.className?`${t.className} ${e}`:e:t.className,i=t.style&&a?{...t.style,...a}:t.style??a;return{...n?{className:n}:null,...i?{style:i}:null}}var cv={plate:{kKwaWg:"x1xzktwu",ku685b:"x1fro9wb",kSiTet:"x27vdmw",kKVMdj:"xpjgpil x1aquc0h",k44tkh:"x7s8090",kyAemX:"x4hg4is",ko0y90:"xa4qsjk",kILWW9:"xpz12be",k6sLGO:"x1so62im",$$css:!0}},yp={root:{kVAEAm:"x10l6tqk",kpwlN0:"x10a8y8t",kVQacm:"xb3r6kr",kWkggS:"xnf4n8c",k6WDB:"xm5t9ug",kgeoSG:"x1cpjm7i",kEoFBp:"x1hmns74",kFcpXp:"xxx281p",k3DiCg:"x19nmgeo",$$css:!0},staticClouds:{kVAEAm:"x10l6tqk",kpwlN0:"x10a8y8t",$$css:!0}};var hf=Ua(Ns(),1);function fv({className:t,xstyle:e,animated:a=!0}){return(0,hf.jsx)("div",{"aria-hidden":"true",...Dr(bt(yp.root,e),t),"data-testid":"sky-cloud-backdrop",children:a?(0,hf.jsx)(lv,{}):(0,hf.jsx)("div",{"aria-hidden":"true",...bt(yp.staticClouds,cv.plate)})})}var mt={root:{kHBbk8:"xc8icb0",kVQacm:"xb3r6kr",kWkggS:"x42x0ya",kMwMTN:"x1awj2ng",$$css:!0},screen:{kVAEAm:"xixxii4",kpwlN0:"x10a8y8t",kY2c9j:"x7elcn7",kAzted:"x1ov3xa9",$$css:!0},pane:{kVAEAm:"x1n2onr6",kZKoxP:"x5yr21d",kAzted:"x19r4su4",kzqmXN:"xh8yej3",$$css:!0},embedded:{kVAEAm:"x10l6tqk",kpwlN0:"x10a8y8t",$$css:!0},wrap:{kVAEAm:"x1n2onr6",kY2c9j:"x1n327nk",k1xSpc:"xrvj5dj",kAzted:"x1us19tq",kgQiWS:"x1ku5rj1",kg3NbH:"x1qhpy6z",k8WAf4:"x1j6fjeo",$$css:!0},paneContent:{kzqmXN:"xh8yej3",ks0D6T:"x7kya4p",kg3NbH:"xzsmjar",k8WAf4:"xn48sxs",$$css:!0},fullContent:{kzqmXN:"x1rz3yb2",kg3NbH:"x129psgg",k8WAf4:"xn48sxs",kYLs0V:"x15iqg5u",kU12DH:"x1tr0e8x",$$css:!0},row:{k1xSpc:"x78zum5",kGNEyG:"x1cy8zhl",kOIVth:"x15iy025",$$css:!0},icon:{k1xSpc:"xrvj5dj",kzqmXN:"x188tqju",kZKoxP:"x1pizb70",kmuXW:"x2lah0s",kgQiWS:"x1ku5rj1",kMwMTN:"xphggvg",$$css:!0},spin:{kzqmXN:"xmombtg",kZKoxP:"xu53h13",kKVMdj:"x1aerksh x1aquc0h",k44tkh:"x1q3qbx4",kyAemX:"x1esw782",ko0y90:"xa4qsjk",$$css:!0},body:{k7Eaqz:"xeuugli",kUk6DE:"x98rzlu",$$css:!0},title:{k63SB2:"x1s688f",kb6lSQ:"x1w69ole",kMwMTN:"x1awj2ng",$$css:!0},titlePane:{kGuDYH:"x1aueamr",kLWn49:"xqomv1q",keoZOQ:"x1mjqqkp",$$css:!0},titleFull:{kGuDYH:"x1r90a5f",kLWn49:"xhacrq1",keoZOQ:"x1mjqqkp",$$css:!0},detail:{keoZOQ:"x5y4uik",kGuDYH:"x1lkfr7t",kLWn49:"x17mssa0",kMwMTN:"x38f5v3",$$css:!0},progressWrap:{keoZOQ:"xa8nrbp",$$css:!0},progressTrack:{kZKoxP:"x164u9eo",kVQacm:"xb3r6kr",kaIpWk:"x10hpsqq",kWkggS:"xhkldz1",$$css:!0},progressFill:{kZKoxP:"x5yr21d",kaIpWk:"x10hpsqq",kWkggS:"xphe6ip",k1ekBW:"xxrbq2n",kIyJzY:"x1d8287x",kAMwcw:"x9lcvmn",$$css:!0},shimmer:{kZKoxP:"x5yr21d",kzqmXN:"x1kbppkt xie2s74",kaIpWk:"x10hpsqq",kWkggS:"xphe6ip",kKVMdj:"x1rhffln x1aquc0h",k44tkh:"xmg6eyc",kyAemX:"x4hg4is",ko0y90:"xa4qsjk",$$css:!0},progressMeta:{keoZOQ:"x5y4uik",k1xSpc:"x78zum5",kjj79g:"x13a6bvl",kMv6JI:"x12e830c",kGuDYH:"xfifm61",kP9fke:"xtvhhri",kb6lSQ:"x7447wj",kMwMTN:"x1xeuy8b",$$css:!0},telemetry:{keoZOQ:"xwg69jb",kaIpWk:"x1yt6v20",kMzoRj:"xmkeg23",kg3NbH:"xnxx81d",k8WAf4:"xo0yzjp",kMv6JI:"x12e830c",kGuDYH:"x4z9k3i",kMwMTN:"x1d3faxd",kWkggS:"xw3p576",kVAM5u:"x1eo6qxu",$$css:!0},telemetryStalled:{kVAM5u:"x1bgw0s5",kWkggS:"xklqylz",kMwMTN:"xl7hjui",$$css:!0},telemRow:{k1xSpc:"x78zum5",kGNEyG:"x6s0dn4",kjj79g:"x1qughib",kOIVth:"x8fetqu",$$css:!0},telemText:{keoZOQ:"x1mjqqkp",kGuDYH:"xfifm61",kP9fke:"xtvhhri",kb6lSQ:"x1dor1uw",kMwMTN:"x1mjg8q5",$$css:!0},telemWarn:{keoZOQ:"x1mjqqkp",kGuDYH:"xfifm61",kP9fke:"xtvhhri",kb6lSQ:"x1dor1uw",kMwMTN:"x14rmedj",$$css:!0},activity:{k1xSpc:"x3nfvp2",kGNEyG:"x6s0dn4",kOIVth:"x13z6uf9",$$css:!0},activityIcon:{kzqmXN:"x1xvt488",kZKoxP:"xf08kfj",kmuXW:"x2lah0s",kMwMTN:"xphggvg",kKVMdj:"x1aerksh x1aquc0h",k44tkh:"x1q3qbx4",kyAemX:"x1esw782",ko0y90:"xa4qsjk",$$css:!0}};var Sn=Ua(Kn(),1),$T=(0,Sn.createContext)(null);function dv(t){let e=(0,Sn.useContext)($T),n=`cloud-loading-${(0,Sn.useId)()}`,i=(0,Sn.useRef)(t);return i.current=t,(0,Sn.useLayoutEffect)(()=>{if(e)return e.setSource(n,i.current),()=>e.setSource(n,null)},[e,n]),(0,Sn.useLayoutEffect)(()=>{e?.setSource(n,t)},[e,t,n]),e!==null}var yt=Ua(Ns(),1);function pv({scope:t="pane",kind:e="route",priority:a,title:n,detail:i,progress:s,progressValueLabel:r,activityToken:o,telemetry:l,phase:u,icon:d,children:p,className:c,xstyle:h,style:v,backdropAnimated:b=t!=="pane",backdropClassName:m,contentWrapClassName:f,contentClassName:x,testId:S="cloud-loading-surface",contentTestId:_="cloud-loading-content",telemetryTestId:L="cloud-loading-telemetry",role:C="status",ariaBusy:T=C!=="alert",ariaHidden:y=!1,dataTransitionState:A}){let E=(0,hv.useMemo)(()=>t!=="screen"?null:{kind:e,title:n,detail:i,progress:s,progressValueLabel:r,activityToken:o,telemetry:l,phase:u,priority:a,severity:C==="alert"?"error":"loading",icon:d,actions:p},[o,p,i,d,e,u,a,s,r,C,t,l,n]),w=dv(E),B=tI(s),X=s!==void 0;return w&&t==="screen"?null:(0,yt.jsxs)("div",{"aria-busy":T,"aria-hidden":y||void 0,"aria-live":C==="alert"?"assertive":"polite",...Dr(bt(mt.root,t==="screen"&&mt.screen,t==="pane"&&mt.pane,t==="embedded"&&mt.embedded,h),c,v),"data-cloud-loading-scope":t,"data-load-kind":e,"data-load-phase":u,"data-transition-state":A,"data-testid":S,role:C,children:[(0,yt.jsx)(fv,{animated:b,className:m}),(0,yt.jsx)("div",{...Dr(bt(mt.wrap),f),children:(0,yt.jsxs)("div",{...Dr(bt(t==="pane"?mt.paneContent:mt.fullContent),x),"data-testid":_,children:[(0,yt.jsxs)("div",{...bt(mt.row),children:[(0,yt.jsx)("div",{...bt(mt.icon),children:d??(0,yt.jsx)(Ei,{"aria-hidden":"true",...bt(mt.spin)})}),(0,yt.jsxs)("div",{...bt(mt.body),children:[(0,yt.jsx)("h2",{...bt(mt.title,t==="pane"?mt.titlePane:mt.titleFull),children:n}),i?(0,yt.jsx)("p",{...bt(mt.detail),children:i}):null,l?(0,yt.jsx)(eI,{telemetry:l,testId:L}):null]})]}),X?(0,yt.jsxs)("div",{...bt(mt.progressWrap),children:[(0,yt.jsx)("div",{"aria-label":`${n} progress`,"aria-valuemax":100,"aria-valuemin":0,"aria-valuenow":B??void 0,...bt(mt.progressTrack),role:"progressbar",children:B==null?(0,yt.jsx)("div",{...bt(mt.shimmer)}):(0,yt.jsx)("div",{...bt(mt.progressFill),style:{width:`${B}%`}})}),(0,yt.jsx)("div",{...bt(mt.progressMeta),children:(0,yt.jsx)("span",{children:r??(B==null?"Working":`${B}%`)})})]}):null,p]})})]})}function eI({telemetry:t,testId:e}){return(0,yt.jsxs)("div",{...bt(mt.telemetry,t.stalled&&mt.telemetryStalled),"data-testid":e,children:[(0,yt.jsxs)("div",{...bt(mt.telemRow),children:[(0,yt.jsxs)("span",{children:[t.transferred,t.total?` / ${t.total}`:" downloaded"]}),t.speed?(0,yt.jsx)("span",{children:t.speed}):null]}),t.eta?(0,yt.jsxs)("p",{...bt(mt.telemText),children:[t.eta," remaining"]}):null,t.stalled?(0,yt.jsxs)("p",{...bt(mt.telemWarn),children:["No bytes received for ",t.stalledFor??"several seconds"]}):null]})}function tI(t){return t==null||!Number.isFinite(t)?null:Math.max(0,Math.min(100,Math.round(t)))}var YM=Ua(XM()),Rw={"starting.html":{surface:{title:"Starting the local host",detail:"Applying migrations, seeding, and waiting for the server to answer. Studio opens as soon as it does.",progress:null,progressLabel:"Local host",progressValueLabel:"Starting"}},"host-exited.html":{surface:{title:"The local host stopped",detail:"Studio can't reach its server. Durable jobs continue under their own supervisor and nothing on disk is affected. Quit and reopen SimForge Studio to start the host again.",role:"alert"},exitCode:!0,alertIcon:!0}};function Dw(){let[t,e]=(0,Zn.useState)("unknown");return(0,Zn.useEffect)(()=>{e(new URLSearchParams(location.search).get("code")??"unknown")},[]),(0,Zn.createElement)("p",{style:{marginTop:"1.5rem",fontFamily:"var(--font-mono)",fontSize:"11px",letterSpacing:"0.12em",textTransform:"uppercase",color:"rgb(255 255 255 / 35%)"}},"Exit code ",(0,Zn.createElement)("code",null,t))}function Pw(t){let e=Rw[t];return(0,Zn.createElement)(pv,{scope:"screen",eyebrow:"SimForge",...e.surface,icon:e.alertIcon?(0,Zn.createElement)(Ii,{"aria-hidden":"true",style:{width:"1.25rem",height:"1.25rem"}}):void 0},e.exitCode?(0,Zn.createElement)(Dw):null)}(0,YM.hydrateRoot)(document.getElementById("surface"),Pw(document.documentElement.dataset.page));})();
