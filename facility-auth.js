import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

export async function hasFacilitySession(auth, facilityId) {
    if (!facilityId) return false;
    const user = await new Promise(resolve => {
        let unsubscribe = () => {};
        unsubscribe = onAuthStateChanged(auth, authenticatedUser => {
            unsubscribe();
            resolve(authenticatedUser);
        });
    });
    if (!user || user.uid !== facilityId) return false;
    const tokenResult = await user.getIdTokenResult();
    return tokenResult.claims.role === "facility";
}